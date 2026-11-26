/**
 * Stock. Voir docs/specs, section « Calcul du stock ».
 *
 * Le stock n'est jamais modifié directement : on enregistre des mouvements datés, sur le
 * téléphone du boss uniquement, et le stock se calcule à partir d'eux :
 *
 *   stock = quantité du dernier comptage + somme des mouvements dont l'heure est postérieure à ce comptage
 *
 * Une vente faite hors ligne avant un comptage mais reçue après est déjà incluse dans le
 * comptage : elle n'est pas retirée une seconde fois. Le résultat ne dépend pas de l'ordre
 * d'arrivée. `item.stock_quantity` garde le résultat en cache (recalculé à chaque mouvement)
 * et part aux employés, qui ne le modifient jamais.
 */
import { raiseAlert } from '../alerts/alerts';
import { findItem } from '../catalog/items';
import type { Item } from '../catalog/types';
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { num, str, strOrNull } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';

export type StockMovementType = 'SALE' | 'SALE_CORRECTION' | 'ENTRY' | 'LOSS' | 'INVENTORY';

export interface StockMovement {
  id: string;
  itemId: string;
  type: StockMovementType;
  /** Variation (négative pour une sortie). `null` pour un comptage. */
  quantityDelta: number | null;
  /** Quantité comptée. Seulement pour un comptage. */
  countedQuantity: number | null;
  occurredAt: string;
  saleId: string | null;
  userId: string;
  reason: string | null;
  createdAt: string;
}

const toMovement = (r: Row): StockMovement => ({
  id: str(r, 'id'),
  itemId: str(r, 'item_id'),
  type: str(r, 'type') as StockMovementType,
  quantityDelta: r.quantity_delta == null ? null : num(r, 'quantity_delta'),
  countedQuantity: r.counted_quantity == null ? null : num(r, 'counted_quantity'),
  occurredAt: str(r, 'occurred_at'),
  saleId: strOrNull(r, 'sale_id'),
  userId: str(r, 'user_id'),
  reason: strOrNull(r, 'reason'),
  createdAt: str(r, 'created_at'),
});

export const MAX_STOCK_QUANTITY = 1_000_000;

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------

/** Calcule le stock d'un article à partir de ses mouvements (sans rien écrire). */
export async function computeStock(db: SqlExecutor, itemId: string): Promise<number> {
  // « Postérieur » = heure plus tardive ; à heure égale, enregistré après (rowid croissant
  // sur le téléphone du boss, seul à écrire des mouvements).
  const { rows } = await db.execute(
    `SELECT counted_quantity, occurred_at, rowid AS rid FROM stock_movement
     WHERE item_id = ? AND type = 'INVENTORY'
     ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    [itemId],
  );
  const last = rows[0];
  const base = last ? num(last, 'counted_quantity') : 0;
  const since = last ? str(last, 'occurred_at') : null;
  const sinceRowid = last ? num(last, 'rid') : 0;
  const { rows: sum } = await db.execute(
    `SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM stock_movement
     WHERE item_id = ? AND type <> 'INVENTORY'
       AND (? IS NULL OR occurred_at > ? OR (occurred_at = ? AND rowid > ?))`,
    [itemId, since, since, since, sinceRowid],
  );
  return base + num(sum[0]!, 'total');
}

type StockLevel = 'OK' | 'LOW' | 'NEGATIVE';
const levelOf = (quantity: number, threshold: number | null): StockLevel =>
  quantity < 0 ? 'NEGATIVE' : quantity === 0 || (threshold != null && quantity <= threshold) ? 'LOW' : 'OK';
const severity: Record<StockLevel, number> = { OK: 0, LOW: 1, NEGATIVE: 2 };

/**
 * Recalcule le stock en cache d'un article, dans la transaction en cours. Si la quantité change,
 * l'article reçoit un nouveau seq (les employés verront le nouveau stock), et une alerte est
 * créée pour le boss quand le stock devient bas ou négatif (pas à chaque mouvement).
 */
export async function refreshStock(ctx: CoreContext, tx: SqlExecutor, itemId: string): Promise<number> {
  const { rows } = await tx.execute(
    `SELECT i.*, c.stock_enabled FROM item i JOIN company c ON c.id = i.company_id WHERE i.id = ?`,
    [itemId],
  );
  const item = rows[0];
  if (!item) throw new DomainError('NOT_FOUND', 'Article introuvable.');
  const before = num(item, 'stock_quantity');
  const after = await computeStock(tx, itemId);
  if (after === before) return after;

  await tx.execute('UPDATE item SET stock_quantity = ?, seq = ? WHERE id = ?', [after, await nextSeq(ctx, tx), itemId]);

  const threshold = item.stock_alert_threshold == null ? null : num(item, 'stock_alert_threshold');
  const [old, now] = [levelOf(before, threshold), levelOf(after, threshold)];
  if (Number(item.is_stock_tracked) === 1 && Number(item.stock_enabled) === 1 && severity[now] > severity[old]) {
    await raiseAlert(ctx, tx, str(item, 'company_id'), {
      type: now === 'NEGATIVE' ? 'NEGATIVE_STOCK' : 'LOW_STOCK',
      entityType: 'ITEM',
      entityId: itemId,
      message: now === 'NEGATIVE' ? `Stock négatif pour « ${item.name} » : ${after}.` : `Stock bas pour « ${item.name} » : ${after}.`,
    });
  }
  return after;
}

// ---------------------------------------------------------------------------
// Mouvements liés aux ventes (appelé par la finalisation des ventes chez le boss)
// ---------------------------------------------------------------------------

/**
 * Met les mouvements de stock d'une vente en accord avec son état actuel, pour chaque produit suivi :
 * effet voulu = − quantité vendue (0 si la vente est annulée) ; on enregistre la différence avec
 * ce qui est déjà enregistré (SALE la première fois pour un article, SALE_CORRECTION ensuite).
 * Rejouer la même vente ne change donc rien.
 *
 * Datation (décision du 26/11/2026) :
 * - première prise en compte de la vente (saisie par le boss ou réception) : heure de la vente ;
 * - correction ou annulation : heure à laquelle elle est enregistrée — le stock change à ce moment-là.
 */
export async function syncSaleStockMovements(
  ctx: CoreContext,
  tx: SqlExecutor,
  saleId: string,
  options: { firstReception: boolean; userId?: string },
): Promise<void> {
  const { rows: saleRows } = await tx.execute('SELECT company_id, status, occurred_at, entered_by_id FROM sale WHERE id = ?', [saleId]);
  const sale = saleRows[0];
  if (!sale) throw new DomainError('NOT_FOUND', 'Vente introuvable.');

  // Effet voulu par article suivi, et effet déjà enregistré par article.
  const { rows } = await tx.execute(
    `WITH wanted AS (
       SELECT l.item_id, -SUM(l.quantity) AS delta FROM sale_line l JOIN item i ON i.id = l.item_id
       WHERE l.sale_id = ? AND i.is_stock_tracked = 1 GROUP BY l.item_id
     ),
     recorded AS (
       SELECT m.item_id, SUM(m.quantity_delta) AS delta, MAX(m.type = 'SALE') AS has_sale
       FROM stock_movement m JOIN item i ON i.id = m.item_id
       WHERE m.sale_id = ? AND i.is_stock_tracked = 1 GROUP BY m.item_id
     )
     SELECT item_id, delta AS wanted, NULL AS recorded, 0 AS has_sale FROM wanted WHERE item_id NOT IN (SELECT item_id FROM recorded)
     UNION ALL
     SELECT r.item_id, COALESCE(w.delta, 0), r.delta, r.has_sale FROM recorded r LEFT JOIN wanted w ON w.item_id = r.item_id`,
    [saleId, saleId],
  );

  const cancelled = sale.status === 'CANCELLED';
  const now = toIso(ctx.clock.now());
  const occurredAt = options.firstReception ? str(sale, 'occurred_at') : now;
  const userId = options.userId ?? str(sale, 'entered_by_id');
  for (const r of rows) {
    const wanted = cancelled ? 0 : num(r, 'wanted');
    const recorded = r.recorded == null ? 0 : num(r, 'recorded');
    const diff = wanted - recorded;
    if (diff === 0) continue;
    const itemId = str(r, 'item_id');
    await tx.execute(
      `INSERT INTO stock_movement (id, company_id, item_id, type, quantity_delta, occurred_at, sale_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.ids.newId(),
        str(sale, 'company_id'),
        itemId,
        Number(r.has_sale) === 1 ? 'SALE_CORRECTION' : 'SALE',
        diff,
        occurredAt,
        saleId,
        userId,
        now,
      ],
    );
    await refreshStock(ctx, tx, itemId);
  }
}

// ---------------------------------------------------------------------------
// Commandes du boss
// ---------------------------------------------------------------------------

function requireStockManager(ctx: CoreContext, actor: Actor) {
  requireBoss(actor);
  requireBossDevice(ctx);
}

async function trackedProduct(tx: SqlExecutor, companyId: string, itemId: string): Promise<Item> {
  const item = await findItem(tx, companyId, itemId);
  if (!item.isStockTracked) throw new DomainError('VALIDATION', `Le stock de « ${item.name} » n'est pas suivi.`, { field: 'itemId' });
  return item;
}

/** Heure d'un mouvement saisi à la main : maintenant par défaut, jamais dans le futur. */
function movementTime(ctx: CoreContext, occurredAt: string | undefined): string {
  const now = ctx.clock.now();
  if (occurredAt === undefined) return toIso(now);
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) throw new DomainError('VALIDATION', 'Date invalide.', { field: 'occurredAt' });
  if (ms > now) throw new DomainError('VALIDATION', 'Un mouvement ne peut pas être daté dans le futur.', { field: 'occurredAt' });
  return toIso(ms);
}

async function insertManualMovement(
  ctx: CoreContext,
  tx: SqlExecutor,
  actor: Actor,
  itemId: string,
  movement: { type: 'ENTRY' | 'LOSS' | 'INVENTORY'; delta?: number; counted?: number; occurredAt: string; reason: string | null },
) {
  await tx.execute(
    `INSERT INTO stock_movement (id, company_id, item_id, type, quantity_delta, counted_quantity, occurred_at, user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.ids.newId(),
      actor.companyId,
      itemId,
      movement.type,
      movement.delta ?? null,
      movement.counted ?? null,
      movement.occurredAt,
      actor.userId,
      movement.reason,
      toIso(ctx.clock.now()),
    ],
  );
  await refreshStock(ctx, tx, itemId);
}

/**
 * Active le suivi du stock d'un produit, avec sa quantité de départ (enregistrée comme un comptage).
 * Le module stock doit être activé pour l'entreprise. Les ventes antérieures ne comptent pas.
 */
export async function enableStockTracking(
  ctx: CoreContext,
  actor: Actor,
  itemId: string,
  input: { initialQuantity: number; alertThreshold?: number | null },
): Promise<Item> {
  requireStockManager(ctx, actor);
  const initial = v.integerInRange('initialQuantity', input.initialQuantity, 0, MAX_STOCK_QUANTITY);
  await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.execute('SELECT stock_enabled FROM company WHERE id = ?', [actor.companyId]);
    if (Number(rows[0]?.stock_enabled) !== 1) {
      throw new DomainError('FORBIDDEN', "Le suivi de stock est désactivé pour l'entreprise. Activez-le d'abord dans les paramètres.");
    }
    const item = await findItem(tx, actor.companyId, itemId);
    if (item.type !== 'PRODUCT') throw new DomainError('VALIDATION', "Un service n'a pas de stock.", { field: 'itemId' });
    if (item.isStockTracked) throw new DomainError('CONFLICT', `Le stock de « ${item.name} » est déjà suivi.`);
    await tx.execute('UPDATE item SET is_stock_tracked = 1, stock_alert_threshold = ?, updated_at = ?, seq = ? WHERE id = ?', [
      input.alertThreshold == null ? null : v.integerInRange('alertThreshold', input.alertThreshold, 0, MAX_STOCK_QUANTITY),
      toIso(ctx.clock.now()),
      await nextSeq(ctx, tx),
      itemId,
    ]);
    await insertManualMovement(ctx, tx, actor, itemId, { type: 'INVENTORY', counted: initial, occurredAt: toIso(ctx.clock.now()), reason: 'Quantité de départ' });
  });
  return findItem(ctx.db, actor.companyId, itemId);
}

/** Arrête le suivi du stock d'un produit. L'historique des mouvements est conservé ; un nouveau départ demandera un comptage. */
export async function disableStockTracking(ctx: CoreContext, actor: Actor, itemId: string): Promise<Item> {
  requireStockManager(ctx, actor);
  await ctx.db.transaction(async (tx) => {
    await trackedProduct(tx, actor.companyId, itemId);
    await tx.execute('UPDATE item SET is_stock_tracked = 0, updated_at = ?, seq = ? WHERE id = ?', [toIso(ctx.clock.now()), await nextSeq(ctx, tx), itemId]);
  });
  return findItem(ctx.db, actor.companyId, itemId);
}

/** Seuil d'alerte de stock bas (`null` : pas de seuil, alerte seulement à zéro ou en négatif). */
export async function setStockAlertThreshold(ctx: CoreContext, actor: Actor, itemId: string, threshold: number | null): Promise<Item> {
  requireStockManager(ctx, actor);
  await ctx.db.transaction(async (tx) => {
    await trackedProduct(tx, actor.companyId, itemId);
    await tx.execute('UPDATE item SET stock_alert_threshold = ?, updated_at = ? WHERE id = ?', [
      threshold == null ? null : v.integerInRange('alertThreshold', threshold, 0, MAX_STOCK_QUANTITY),
      toIso(ctx.clock.now()),
      itemId,
    ]);
  });
  return findItem(ctx.db, actor.companyId, itemId);
}

/** Entrée de marchandise (livraison, achat). */
export async function recordStockEntry(
  ctx: CoreContext,
  actor: Actor,
  itemId: string,
  input: { quantity: number; reason?: string | null; occurredAt?: string },
): Promise<number> {
  requireStockManager(ctx, actor);
  const quantity = v.integerInRange('quantity', input.quantity, 1, MAX_STOCK_QUANTITY);
  return ctx.db.transaction(async (tx) => {
    await trackedProduct(tx, actor.companyId, itemId);
    await insertManualMovement(ctx, tx, actor, itemId, {
      type: 'ENTRY',
      delta: quantity,
      occurredAt: movementTime(ctx, input.occurredAt),
      reason: v.optionalText('reason', input.reason, 300),
    });
    return computeStock(tx, itemId);
  });
}

/** Perte, casse ou vol. */
export async function recordStockLoss(
  ctx: CoreContext,
  actor: Actor,
  itemId: string,
  input: { quantity: number; reason?: string | null; occurredAt?: string },
): Promise<number> {
  requireStockManager(ctx, actor);
  const quantity = v.integerInRange('quantity', input.quantity, 1, MAX_STOCK_QUANTITY);
  return ctx.db.transaction(async (tx) => {
    await trackedProduct(tx, actor.companyId, itemId);
    await insertManualMovement(ctx, tx, actor, itemId, {
      type: 'LOSS',
      delta: -quantity,
      occurredAt: movementTime(ctx, input.occurredAt),
      reason: v.optionalText('reason', input.reason, 300),
    });
    return computeStock(tx, itemId);
  });
}

/**
 * Comptage : « à telle heure, il y avait telle quantité ». C'est le seul mouvement qui fixe une valeur.
 * Conseil affiché par l'application : synchroniser tous les employés avant de compter.
 */
export async function recordInventory(
  ctx: CoreContext,
  actor: Actor,
  itemId: string,
  input: { countedQuantity: number; reason?: string | null; occurredAt?: string },
): Promise<number> {
  requireStockManager(ctx, actor);
  const counted = v.integerInRange('countedQuantity', input.countedQuantity, 0, MAX_STOCK_QUANTITY);
  return ctx.db.transaction(async (tx) => {
    await trackedProduct(tx, actor.companyId, itemId);
    await insertManualMovement(ctx, tx, actor, itemId, {
      type: 'INVENTORY',
      counted,
      occurredAt: movementTime(ctx, input.occurredAt),
      reason: v.optionalText('reason', input.reason, 300),
    });
    return computeStock(tx, itemId);
  });
}

/** Les mouvements qui expliquent le stock d'un article, les plus récents d'abord (boss seulement). */
export async function listStockMovements(ctx: CoreContext, actor: Actor, itemId: string, limit = 100): Promise<StockMovement[]> {
  requireBoss(actor);
  await findItem(ctx.db, actor.companyId, itemId);
  const { rows } = await ctx.db.execute(
    `SELECT * FROM stock_movement WHERE item_id = ? ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ?`,
    [itemId, limit],
  );
  return rows.map(toMovement);
}

// ---------------------------------------------------------------------------
// Stock affiché
// ---------------------------------------------------------------------------

/**
 * Stock affiché pour chaque produit suivi, par identifiant d'article.
 * - Chez le boss : le stock calculé.
 * - Chez un employé : le stock reçu du boss, moins les ventes saisies sur ce téléphone et pas
 *   encore confirmées. Dès qu'une vente est confirmée, elle est dans le stock du boss et ne
 *   compte plus ici : ni comptée deux fois, ni oubliée.
 */
export async function getDisplayedStock(ctx: CoreContext, actor: Actor): Promise<Record<string, number>> {
  const { rows } = await ctx.db.execute(
    `SELECT i.id, i.stock_quantity - COALESCE((
       SELECT SUM(l.quantity) FROM sale_line l JOIN sale s ON s.id = l.sale_id
       WHERE l.item_id = i.id AND s.device_id = ? AND s.synced_at IS NULL AND s.status = 'ACTIVE'
     ), 0) AS displayed
     FROM item i WHERE i.company_id = ? AND i.is_stock_tracked = 1`,
    [ctx.device.isBoss ? '' : ctx.device.id, actor.companyId],
  );
  return Object.fromEntries(rows.map((r) => [str(r, 'id'), num(r, 'displayed')]));
}
