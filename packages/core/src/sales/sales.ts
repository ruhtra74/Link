/**
 * Ventes — le cœur du modèle. Voir docs/specs, « Enregistrement de l'activité » et « Règles de synchronisation ».
 *
 * Qui peut quoi :
 * - Sur son téléphone, un employé enregistre ses ventes. Il peut les corriger ou les annuler tant
 *   qu'elles ne sont pas synchronisées (pas d'accusé de réception du boss). Ensuite, plus rien.
 * - Sur son téléphone, le boss enregistre ses ventes, ou celles d'un employé (champ « employé ayant
 *   fait la vente »). Il corrige ou annule n'importe quelle vente, avec un motif, sauf dans un exercice clos.
 *
 * Chez le boss, une vente est « finalisée » (`finalizeSaleOnBoss`) : rattachée à l'exercice ouvert,
 * marquée synchronisée, coût d'achat fixé, seq attribué. C'est le même traitement que la réception
 * d'une vente d'employé lors d'une synchro (phase 3).
 */
import { findCustomer } from '../catalog/customers';
import { findItem } from '../catalog/items';
import { findPaymentMethod } from '../catalog/payment-methods';
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor, SqlValue } from '../db/types';
import { DomainError } from '../errors';
import { assertFiscalYearWritable, requireOpenFiscalYear } from '../fiscal-years/fiscal-years';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import * as v from '../shared/validation';
import { syncSaleStockMovements } from '../stock/stock';
import { nextSeq } from '../sync/seq';
import { computeSale, type ComputedSale, type ItemSnapshot, type LineDraft } from './compute';
import { toSale, toSaleLine, type EntryMode, type Sale, type SaleStatus } from './types';

export interface SaleLineInput {
  itemId: string;
  quantity: number;
  /** Prix pratiqué ; par défaut le prix de référence de l'article. */
  unitPrice?: number;
}

export interface SaleInput {
  lines: SaleLineInput[];
  /** Total réellement encaissé, si différent de la somme des lignes (ajustement global). */
  totalAmount?: number;
  customerId?: string | null;
  paymentMethodId?: string | null;
  note?: string | null;
  /** Boss seulement : l'employé qui a fait la vente. Vide = le boss lui-même. */
  employeeId?: string | null;
  entryMode?: EntryMode;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

async function loadSale(db: SqlExecutor, saleRow: Row): Promise<Sale> {
  const { rows } = await db.execute('SELECT * FROM sale_line WHERE sale_id = ? ORDER BY rowid', [String(saleRow.id)]);
  return toSale(saleRow, rows.map(toSaleLine));
}

async function findSaleRow(tx: SqlExecutor, companyId: string, saleId: string): Promise<Row> {
  const { rows } = await tx.execute('SELECT * FROM sale WHERE id = ? AND company_id = ?', [saleId, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Vente introuvable.');
  return rows[0];
}

/** Le coût d'achat n'est jamais montré à un employé. */
const forActor = (actor: Actor, sale: Sale): Sale =>
  actor.role === 'BOSS' ? sale : { ...sale, lines: sale.lines.map((l) => ({ ...l, unitCost: null })) };

/** Une vente. Un employé ne voit que les siennes (sinon : introuvable). */
export async function getSale(ctx: CoreContext, actor: Actor, saleId: string): Promise<Sale> {
  const row = await findSaleRow(ctx.db, actor.companyId, saleId);
  if (actor.role !== 'BOSS' && row.employee_id !== actor.userId) throw new DomainError('NOT_FOUND', 'Vente introuvable.');
  return forActor(actor, await loadSale(ctx.db, row));
}

export interface SaleFilter {
  fiscalYearId?: string;
  /** Bornes sur l'heure de la vente (ISO), `from` inclus, `to` exclu. */
  from?: string;
  to?: string;
  /** Boss seulement ; un employé ne voit que ses ventes. */
  employeeId?: string;
  itemId?: string;
  customerId?: string;
  status?: SaleStatus;
  /** Seulement les ventes pas encore synchronisées. */
  pendingOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** Historique, le plus récent d'abord. Le boss voit toute l'équipe ; un employé, ses seules ventes. */
export async function listSales(ctx: CoreContext, actor: Actor, filter: SaleFilter = {}): Promise<Sale[]> {
  const employeeId = actor.role === 'BOSS' ? (filter.employeeId ?? null) : actor.userId;
  const conditions: string[] = ['s.company_id = ?'];
  const params: SqlValue[] = [actor.companyId];
  const add = (sql: string, ...values: SqlValue[]) => {
    conditions.push(sql);
    params.push(...values);
  };
  if (employeeId) add('s.employee_id = ?', employeeId);
  if (filter.fiscalYearId) add('s.fiscal_year_id = ?', filter.fiscalYearId);
  if (filter.from) add('s.occurred_at >= ?', filter.from);
  if (filter.to) add('s.occurred_at < ?', filter.to);
  if (filter.customerId) add('s.customer_id = ?', filter.customerId);
  if (filter.status) add('s.status = ?', filter.status);
  if (filter.pendingOnly) add('s.synced_at IS NULL');
  if (filter.itemId) add('EXISTS (SELECT 1 FROM sale_line l WHERE l.sale_id = s.id AND l.item_id = ?)', filter.itemId);

  const { rows } = await ctx.db.execute(
    `SELECT s.* FROM sale s WHERE ${conditions.join(' AND ')} ORDER BY s.occurred_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 50, filter.offset ?? 0],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.id));
  const { rows: lineRows } = await ctx.db.execute(
    `SELECT * FROM sale_line WHERE sale_id IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid`,
    ids,
  );
  const linesBySale = new Map<string, Row[]>();
  for (const l of lineRows) linesBySale.set(String(l.sale_id), [...(linesBySale.get(String(l.sale_id)) ?? []), l]);
  return rows.map((r) => forActor(actor, toSale(r, (linesBySale.get(String(r.id)) ?? []).map(toSaleLine))));
}

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------

function assertActorOnThisDevice(ctx: CoreContext, actor: Actor) {
  if (actor.deviceId !== ctx.device.id) throw new DomainError('FORBIDDEN', "Cette session n'appartient pas à ce téléphone.");
}

/**
 * Qui peut modifier ou annuler cette vente ?
 * - Boss, sur son téléphone : toute vente, sauf dans un exercice clos.
 * - Employé : ses propres ventes, saisies sur ce téléphone, pas encore synchronisées.
 */
async function assertCanModify(ctx: CoreContext, tx: SqlExecutor, actor: Actor, sale: Row): Promise<void> {
  assertActorOnThisDevice(ctx, actor);
  if (sale.status === 'CANCELLED') throw new DomainError('FORBIDDEN', 'Cette vente est annulée : elle ne peut plus être modifiée.');
  if (actor.role === 'BOSS') {
    requireBossDevice(ctx);
    if (sale.fiscal_year_id != null) await assertFiscalYearWritable(tx, String(sale.fiscal_year_id));
    return;
  }
  if (sale.employee_id !== actor.userId || sale.device_id !== ctx.device.id) {
    throw new DomainError('FORBIDDEN', 'Vous ne pouvez modifier que vos propres ventes.');
  }
  if (sale.synced_at != null) {
    throw new DomainError('FORBIDDEN', 'Cette vente a été reçue par le boss : seul le boss peut encore la corriger.');
  }
}

// ---------------------------------------------------------------------------
// Construction des lignes
// ---------------------------------------------------------------------------

/**
 * Prépare les lignes. Pour un article déjà présent dans la vente (correction), on garde les
 * informations figées d'origine ; pour un nouvel article, on prend le catalogue actuel
 * (il ne doit pas être archivé).
 */
async function buildDrafts(
  tx: SqlExecutor,
  companyId: string,
  lines: readonly SaleLineInput[],
  frozen: Map<string, ItemSnapshot> = new Map(),
): Promise<LineDraft[]> {
  const drafts: LineDraft[] = [];
  for (const [i, line] of lines.entries()) {
    let snapshot = frozen.get(line.itemId);
    if (!snapshot) {
      const item = await findItem(tx, companyId, line.itemId);
      if (item.isArchived) {
        throw new DomainError('VALIDATION', `« ${item.name} » est archivé : il ne peut plus être vendu.`, { field: `lines[${i}].itemId` });
      }
      snapshot = { id: item.id, name: item.name, type: item.type, referencePrice: item.referencePrice };
    }
    drafts.push({ item: snapshot, quantity: line.quantity, unitPrice: line.unitPrice });
  }
  return drafts;
}

async function insertLines(ctx: CoreContext, tx: SqlExecutor, saleId: string, computed: ComputedSale, costs: Map<string, number> = new Map()) {
  for (const l of computed.lines) {
    await tx.execute(
      `INSERT INTO sale_line (id, sale_id, item_id, item_name, item_type, quantity, reference_price, unit_price, line_total, price_gap, unit_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.ids.newId(), saleId, l.itemId, l.itemName, l.itemType, l.quantity, l.referencePrice, l.unitPrice, l.lineTotal, l.priceGap, costs.get(l.itemId) ?? null],
    );
  }
}

async function validCustomerId(tx: SqlExecutor, companyId: string, id: string | null | undefined) {
  if (!id) return null;
  return (await findCustomer(tx, companyId, id)).id;
}

async function validPaymentMethodId(tx: SqlExecutor, companyId: string, id: string | null | undefined) {
  if (!id) return null;
  const method = await findPaymentMethod(tx, companyId, id);
  if (!method.isActive) throw new DomainError('VALIDATION', `Le mode de paiement « ${method.name} » n'est plus proposé.`, { field: 'paymentMethodId' });
  return method.id;
}

/** Le boss attribue la vente à un employé actif, ou à lui-même. */
async function resolveEmployee(ctx: CoreContext, tx: SqlExecutor, actor: Actor, employeeId: string | null | undefined): Promise<string> {
  if (!ctx.device.isBoss) {
    if (employeeId && employeeId !== actor.userId) throw new DomainError('FORBIDDEN', 'Seul le boss peut saisir une vente au nom d’un employé.');
    return actor.userId;
  }
  if (!employeeId || employeeId === actor.userId) return actor.userId;
  const { rows } = await tx.execute(`SELECT role, is_active FROM user WHERE id = ? AND company_id = ?`, [employeeId, actor.companyId]);
  const user = rows[0];
  if (!user || user.role !== 'EMPLOYEE') throw new DomainError('NOT_FOUND', 'Employé introuvable.', { field: 'employeeId' });
  if (Number(user.is_active) !== 1) throw new DomainError('VALIDATION', 'Cet employé est désactivé.', { field: 'employeeId' });
  return employeeId;
}

// ---------------------------------------------------------------------------
// Finalisation chez le boss (saisie par le boss, ou réception d'une vente d'employé)
// ---------------------------------------------------------------------------

/**
 * Traitement d'une vente sur le téléphone du boss, dans la transaction en cours :
 * - première fois : rattachement à l'exercice ouvert (sinon NO_OPEN_FISCAL_YEAR) et accusé de réception ;
 * - coût d'achat des lignes qui n'en ont pas encore : prix d'achat actuel, 0 sans prix d'achat ou pour un service ;
 * - nouveau seq, pour renvoyer la vente à l'employé en mode conservation ;
 * - mouvements de stock mis en accord avec l'état de la vente : à l'heure de la vente la première fois,
 *   à l'heure de l'enregistrement pour une correction ou une annulation.
 */
/**
 * `correctedBy` : l'auteur d'une correction ou d'une annulation (noté dans les mouvements de stock).
 */
export async function finalizeSaleOnBoss(ctx: CoreContext, tx: SqlExecutor, saleId: string, correctedBy?: string): Promise<void> {
  requireBossDevice(ctx);
  const { rows } = await tx.execute('SELECT company_id, fiscal_year_id, synced_at FROM sale WHERE id = ?', [saleId]);
  const sale = rows[0];
  if (!sale) throw new DomainError('NOT_FOUND', 'Vente introuvable.');
  const now = toIso(ctx.clock.now());
  const fiscalYearId = sale.fiscal_year_id ?? (await requireOpenFiscalYear(tx, String(sale.company_id))).id;

  await tx.execute(
    `UPDATE sale_line SET unit_cost = CASE
       WHEN item_type = 'PRODUCT' THEN COALESCE((SELECT purchase_price FROM item_cost c WHERE c.item_id = sale_line.item_id), 0)
       ELSE 0 END
     WHERE sale_id = ? AND unit_cost IS NULL`,
    [saleId],
  );
  await tx.execute(`UPDATE sale SET fiscal_year_id = ?, synced_at = COALESCE(synced_at, ?), seq = ? WHERE id = ?`, [
    fiscalYearId,
    now,
    await nextSeq(ctx, tx),
    saleId,
  ]);
  // Première prise en compte si la vente n'avait pas encore d'accusé de réception.
  await syncSaleStockMovements(ctx, tx, saleId, { firstReception: sale.synced_at == null, userId: correctedBy });
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/**
 * Enregistre une vente ou un service. Le prix de référence est pré-rempli mais modifiable,
 * le client et le mode de paiement sont facultatifs.
 * Chez le boss : exige un exercice ouvert, et la vente est aussitôt finalisée (déjà synchronisée).
 */
export async function createSale(ctx: CoreContext, actor: Actor, input: SaleInput): Promise<Sale> {
  assertActorOnThisDevice(ctx, actor);
  if (ctx.device.isBoss) requireBoss(actor);
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  const entryMode = v.oneOf('entryMode', input.entryMode ?? 'MANUAL', ['MANUAL', 'BURST'] as const);

  await ctx.db.transaction(async (tx) => {
    if (ctx.device.isBoss) await requireOpenFiscalYear(tx, actor.companyId);
    const employeeId = await resolveEmployee(ctx, tx, actor, input.employeeId);
    const computed = computeSale(await buildDrafts(tx, actor.companyId, input.lines ?? []), input.totalAmount);

    await tx.execute(
      `INSERT INTO sale (id, company_id, employee_id, entered_by_id, device_id, customer_id, payment_method_id, occurred_at,
                         reference_total, adjustment, total_amount, note, entry_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        actor.companyId,
        employeeId,
        actor.userId,
        ctx.device.id,
        await validCustomerId(tx, actor.companyId, input.customerId),
        await validPaymentMethodId(tx, actor.companyId, input.paymentMethodId),
        now,
        computed.referenceTotal,
        computed.adjustment,
        computed.totalAmount,
        v.optionalText('note', input.note, 500),
        entryMode,
        now,
        now,
      ],
    );
    await insertLines(ctx, tx, id, computed);
    if (ctx.device.isBoss) await finalizeSaleOnBoss(ctx, tx, id);
  });
  return getSale(ctx, actor, id);
}

export interface SaleCorrectionInput {
  /** Nouvelles lignes : remplacent toutes les lignes. Sans `totalAmount`, l'ajustement global revient à 0. */
  lines?: SaleLineInput[];
  totalAmount?: number;
  customerId?: string | null;
  paymentMethodId?: string | null;
  note?: string | null;
  /** Motif, obligatoire quand le boss change les articles ou les montants. */
  reason?: string;
}

/**
 * Corrige une vente (sans jamais l'effacer) : articles, montants, client, mode de paiement, note.
 * Chaque correction augmente la version. Rattacher un client après coup est une correction comme une autre.
 */
export async function correctSale(ctx: CoreContext, actor: Actor, saleId: string, input: SaleCorrectionInput): Promise<Sale> {
  await ctx.db.transaction(async (tx) => {
    const row = await findSaleRow(tx, actor.companyId, saleId);
    await assertCanModify(ctx, tx, actor, row);
    const financial = input.lines !== undefined || input.totalAmount !== undefined;
    if (actor.role === 'BOSS' && financial) v.requiredText('reason', input.reason, 500);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (financial) {
      const old = (await loadSale(tx, row)).lines;
      let computed: ComputedSale;
      if (input.lines !== undefined) {
        const frozen = new Map(old.map((l) => [l.itemId, { id: l.itemId, name: l.itemName, type: l.itemType, referencePrice: l.referencePrice }]));
        computed = computeSale(await buildDrafts(tx, actor.companyId, input.lines, frozen), input.totalAmount);
        // Le coût d'achat fixé à la réception est conservé pour les articles déjà présents.
        const costs = new Map(old.filter((l) => l.unitCost != null).map((l) => [l.itemId, l.unitCost!]));
        await tx.execute('DELETE FROM sale_line WHERE sale_id = ?', [saleId]);
        await insertLines(ctx, tx, saleId, computed, costs);
      } else {
        computed = computeSale(
          old.map((l) => ({ item: { id: l.itemId, name: l.itemName, type: l.itemType, referencePrice: l.referencePrice }, quantity: l.quantity, unitPrice: l.unitPrice })),
          input.totalAmount,
        );
      }
      set('reference_total', computed.referenceTotal);
      set('adjustment', computed.adjustment);
      set('total_amount', computed.totalAmount);
    }
    if (input.customerId !== undefined) set('customer_id', await validCustomerId(tx, actor.companyId, input.customerId));
    if (input.paymentMethodId !== undefined) set('payment_method_id', await validPaymentMethodId(tx, actor.companyId, input.paymentMethodId));
    if (input.note !== undefined) set('note', v.optionalText('note', input.note, 500));
    if (sets.length === 0) throw new DomainError('VALIDATION', 'Aucune modification demandée.');

    set('updated_at', toIso(ctx.clock.now()));
    await tx.execute(`UPDATE sale SET ${sets.join(', ')}, version = version + 1 WHERE id = ?`, [...params, saleId]);
    if (ctx.device.isBoss) await finalizeSaleOnBoss(ctx, tx, saleId, actor.userId);
  });
  return getSale(ctx, actor, saleId);
}

/** Annule une vente, avec un motif obligatoire. Elle n'est jamais effacée. */
export async function cancelSale(ctx: CoreContext, actor: Actor, saleId: string, reason: string): Promise<Sale> {
  const motive = v.requiredText('reason', reason, 500);
  await ctx.db.transaction(async (tx) => {
    const row = await findSaleRow(tx, actor.companyId, saleId);
    if (row.status === 'CANCELLED') throw new DomainError('CONFLICT', 'Cette vente est déjà annulée.');
    await assertCanModify(ctx, tx, actor, row);
    const now = toIso(ctx.clock.now());
    await tx.execute(
      `UPDATE sale SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      [motive, actor.userId, now, now, saleId],
    );
    if (ctx.device.isBoss) await finalizeSaleOnBoss(ctx, tx, saleId, actor.userId);
  });
  return getSale(ctx, actor, saleId);
}
