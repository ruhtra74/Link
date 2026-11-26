/**
 * Journal d'audit : qui a fait quoi et quand. Voir docs/specs, « Personnalisation et paramètres ».
 *
 * - Tenu uniquement sur le téléphone du boss (table réservée au boss) ; ailleurs, `recordAudit`
 *   ne fait rien. Les ventes des employés y entreront à leur réception (phase 3).
 * - Chaque entrée est écrite dans la transaction de l'action : l'action et sa trace réussissent
 *   ou échouent ensemble.
 * - On garde l'état avant / après de l'élément (lignes de la base), le motif s'il y en a un, et
 *   l'employé concerné quand le boss agit pour lui. Les mots de passe hachés ne sont jamais copiés.
 * - Global : couvre tous les exercices.
 */
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor, SqlValue } from '../db/types';
import { requireBoss } from '../shared/permissions';
import { str, strOrNull } from '../shared/sql';

export type AuditAction =
  | 'COMPANY_SETUP'
  | 'COMPANY_UPDATE'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_DEACTIVATE'
  | 'USER_REACTIVATE'
  | 'USER_PASSWORD_RESET'
  | 'PROFILE_UPDATE'
  | 'PASSWORD_CHANGE'
  | 'DEVICE_REVOKE'
  | 'YEAR_OPEN'
  | 'YEAR_CLOSE'
  | 'YEAR_UPDATE'
  | 'CATEGORY_CREATE'
  | 'CATEGORY_UPDATE'
  | 'ITEM_CREATE'
  | 'ITEM_UPDATE'
  | 'ITEM_ARCHIVE'
  | 'ITEM_UNARCHIVE'
  | 'ITEM_COST_UPDATE'
  | 'PAYMENT_METHOD_CREATE'
  | 'PAYMENT_METHOD_UPDATE'
  | 'CUSTOMER_CREATE'
  | 'CUSTOMER_UPDATE'
  | 'SALE_CREATE'
  | 'SALE_EDIT'
  | 'SALE_CANCEL'
  | 'STOCK_TRACKING_ENABLE'
  | 'STOCK_TRACKING_DISABLE'
  | 'STOCK_THRESHOLD_UPDATE'
  | 'STOCK_ENTRY'
  | 'STOCK_LOSS'
  | 'STOCK_INVENTORY'
  | 'EXPENSE_CREATE'
  | 'EXPENSE_EDIT'
  | 'EXPENSE_CANCEL';

/** Tables dont on photographie les lignes. */
export type AuditedEntity =
  | 'company'
  | 'user'
  | 'device'
  | 'fiscal_year'
  | 'category'
  | 'item'
  | 'item_cost'
  | 'payment_method'
  | 'customer'
  | 'sale'
  | 'stock_movement'
  | 'expense';

export type Snapshot = Record<string, SqlValue | Record<string, SqlValue>[]>;

/** Colonnes jamais copiées dans le journal. */
const SECRET_COLUMNS = new Set(['password_hash']);

/**
 * État actuel d'un élément, tel qu'en base (sans secret). Pour une vente, avec ses lignes.
 * `null` si l'élément n'existe pas (encore).
 */
export async function snapshot(tx: SqlExecutor, entity: AuditedEntity, id: string): Promise<Snapshot | null> {
  const key = entity === 'item_cost' ? 'item_id' : 'id';
  const { rows } = await tx.execute(`SELECT * FROM ${entity} WHERE ${key} = ?`, [id]);
  if (!rows[0]) return null;
  const clean: Snapshot = Object.fromEntries(Object.entries(rows[0]).filter(([k]) => !SECRET_COLUMNS.has(k)));
  if (entity === 'sale') {
    clean.lines = (await tx.execute('SELECT * FROM sale_line WHERE sale_id = ? ORDER BY rowid', [id])).rows;
  }
  return clean;
}

export interface AuditInput {
  action: AuditAction;
  entityType: AuditedEntity;
  entityId: string;
  /** L'employé concerné quand ce n'est pas l'auteur (ex. vente saisie par le boss pour un employé). */
  onBehalfOf?: string | null;
  reason?: string | null;
  before?: Snapshot | null;
  after?: Snapshot | null;
}

/** Inscrit une entrée dans le journal, dans la transaction en cours (téléphone du boss uniquement). */
export async function recordAudit(ctx: CoreContext, tx: SqlExecutor, actor: Actor, entry: AuditInput): Promise<void> {
  if (!ctx.device.isBoss) return;
  await tx.execute(
    `INSERT INTO audit_log (id, company_id, actor_id, on_behalf_of_id, device_id, action, entity_type, entity_id, reason, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ctx.ids.newId(),
      actor.companyId,
      actor.userId,
      entry.onBehalfOf && entry.onBehalfOf !== actor.userId ? entry.onBehalfOf : null,
      actor.deviceId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.reason ?? null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      toIso(ctx.clock.now()),
    ],
  );
}

/**
 * Raccourci pour une modification : photographie avant, applique `change`, photographie après,
 * puis inscrit l'entrée. Renvoie le résultat de `change`.
 */
export async function audited<T>(
  ctx: CoreContext,
  tx: SqlExecutor,
  actor: Actor,
  entry: Omit<AuditInput, 'before' | 'after'>,
  change: () => Promise<T>,
): Promise<T> {
  const before = ctx.device.isBoss ? await snapshot(tx, entry.entityType, entry.entityId) : null;
  const result = await change();
  if (ctx.device.isBoss) {
    await recordAudit(ctx, tx, actor, { ...entry, before, after: await snapshot(tx, entry.entityType, entry.entityId) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Consultation (boss)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  actorId: string;
  onBehalfOfId: string | null;
  deviceId: string;
  action: AuditAction;
  entityType: AuditedEntity;
  entityId: string;
  reason: string | null;
  before: Snapshot | null;
  after: Snapshot | null;
  createdAt: string;
}

const parse = (v: SqlValue | undefined): Snapshot | null => (v == null ? null : (JSON.parse(String(v)) as Snapshot));

const toEntry = (r: Row): AuditEntry => ({
  id: str(r, 'id'),
  actorId: str(r, 'actor_id'),
  onBehalfOfId: strOrNull(r, 'on_behalf_of_id'),
  deviceId: str(r, 'device_id'),
  action: str(r, 'action') as AuditAction,
  entityType: str(r, 'entity_type') as AuditedEntity,
  entityId: str(r, 'entity_id'),
  reason: strOrNull(r, 'reason'),
  before: parse(r.before_json),
  after: parse(r.after_json),
  createdAt: str(r, 'created_at'),
});

export interface AuditFilter {
  entityType?: AuditedEntity;
  entityId?: string;
  /** Actions faites par cette personne, ou la concernant (« pour le compte de »). */
  userId?: string;
  action?: AuditAction;
  /** Bornes ISO : `from` inclus, `to` exclu. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Le journal, le plus récent d'abord (boss seulement). */
export async function listAuditLog(ctx: CoreContext, actor: Actor, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  requireBoss(actor);
  const conditions = ['company_id = ?'];
  const params: SqlValue[] = [actor.companyId];
  const add = (sql: string, ...values: SqlValue[]) => {
    conditions.push(sql);
    params.push(...values);
  };
  if (filter.entityType) add('entity_type = ?', filter.entityType);
  if (filter.entityId) add('entity_id = ?', filter.entityId);
  if (filter.userId) add('(actor_id = ? OR on_behalf_of_id = ?)', filter.userId, filter.userId);
  if (filter.action) add('action = ?', filter.action);
  if (filter.from) add('created_at >= ?', filter.from);
  if (filter.to) add('created_at < ?', filter.to);
  const { rows } = await ctx.db.execute(
    `SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 100, filter.offset ?? 0],
  );
  return rows.map(toEntry);
}
