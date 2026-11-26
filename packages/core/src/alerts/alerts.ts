/**
 * Alertes affichées au boss (stock bas ou négatif, employé qui ne synchronise plus…).
 * Elles n'existent que sur le téléphone du boss.
 */
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss } from '../shared/permissions';
import { str, strOrNull } from '../shared/sql';

export type AlertType = 'LOW_STOCK' | 'NEGATIVE_STOCK' | 'STALE_SYNC' | 'CANCELLED_SALE';

export interface Alert {
  id: string;
  type: AlertType;
  entityType: string;
  entityId: string;
  message: string | null;
  createdAt: string;
  readAt: string | null;
}

const toAlert = (r: Row): Alert => ({
  id: str(r, 'id'),
  type: str(r, 'type') as AlertType,
  entityType: str(r, 'entity_type'),
  entityId: str(r, 'entity_id'),
  message: strOrNull(r, 'message'),
  createdAt: str(r, 'created_at'),
  readAt: strOrNull(r, 'read_at'),
});

export async function raiseAlert(
  ctx: CoreContext,
  tx: SqlExecutor,
  companyId: string,
  alert: { type: AlertType; entityType: string; entityId: string; message: string },
): Promise<void> {
  await tx.execute(`INSERT INTO alert (id, company_id, type, entity_type, entity_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    ctx.ids.newId(),
    companyId,
    alert.type,
    alert.entityType,
    alert.entityId,
    alert.message,
    toIso(ctx.clock.now()),
  ]);
}

/** Alertes, les plus récentes d'abord (boss seulement). */
export async function listAlerts(ctx: CoreContext, actor: Actor, options: { unreadOnly?: boolean } = {}): Promise<Alert[]> {
  requireBoss(actor);
  const { rows } = await ctx.db.execute(
    `SELECT * FROM alert WHERE company_id = ? AND (? = 0 OR read_at IS NULL) ORDER BY created_at DESC, id DESC`,
    [actor.companyId, options.unreadOnly ? 1 : 0],
  );
  return rows.map(toAlert);
}

export async function markAlertRead(ctx: CoreContext, actor: Actor, alertId: string): Promise<void> {
  requireBoss(actor);
  const { changes } = await ctx.db.execute(`UPDATE alert SET read_at = COALESCE(read_at, ?) WHERE id = ? AND company_id = ?`, [
    toIso(ctx.clock.now()),
    alertId,
    actor.companyId,
  ]);
  if (changes === 0) throw new DomainError('NOT_FOUND', 'Alerte introuvable.');
}
