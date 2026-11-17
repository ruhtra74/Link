/**
 * Appareils. L'appairage par QR code arrive en phase 3 ; ici, les règles déjà utiles :
 * révocation par le boss et révocation automatique à la désactivation d'un employé.
 */
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss } from '../shared/permissions';
import { nextSeq } from '../sync/seq';
import { toDevice, type Device } from './types';

/**
 * Révoque un appareil (téléphone perdu, changé ou rendu). Il effacera toutes ses données,
 * copie de secours comprise, à sa prochaine synchronisation. Le téléphone du boss ne se révoque pas.
 */
export async function revokeDevice(ctx: CoreContext, actor: Actor, deviceId: string): Promise<Device> {
  requireBoss(actor);
  if (deviceId === ctx.device.id) throw new DomainError('FORBIDDEN', 'Le téléphone du boss ne peut pas être révoqué.');
  await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.execute('SELECT status FROM device WHERE id = ? AND company_id = ?', [deviceId, actor.companyId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'Appareil introuvable.');
    if (rows[0].status !== 'REVOKED') await markRevoked(ctx, tx, deviceId);
  });
  return toDevice((await ctx.db.execute('SELECT * FROM device WHERE id = ?', [deviceId])).rows[0]!);
}

/** Révoque tous les appareils actifs d'un compte, dans la transaction en cours. */
export async function revokeDevicesOfUser(ctx: CoreContext, tx: SqlExecutor, userId: string): Promise<void> {
  const { rows } = await tx.execute(`SELECT id FROM device WHERE user_id = ? AND status = 'ACTIVE'`, [userId]);
  for (const r of rows) await markRevoked(ctx, tx, String(r.id));
}

async function markRevoked(ctx: CoreContext, tx: SqlExecutor, deviceId: string) {
  await tx.execute(`UPDATE device SET status = 'REVOKED', revoked_at = ?, wipe_pending = 1, seq = ? WHERE id = ?`, [
    toIso(ctx.clock.now()),
    await nextSeq(ctx, tx),
    deviceId,
  ]);
}

/** Les appareils de l'entreprise, ou d'un seul compte (boss seulement). */
export async function listDevices(ctx: CoreContext, actor: Actor, userId?: string): Promise<Device[]> {
  requireBoss(actor);
  const { rows } = await ctx.db.execute(
    `SELECT * FROM device WHERE company_id = ? AND (? IS NULL OR user_id = ?) ORDER BY paired_at`,
    [actor.companyId, userId ?? null, userId ?? null],
  );
  return rows.map(toDevice);
}
