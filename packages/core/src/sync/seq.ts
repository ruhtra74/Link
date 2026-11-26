/**
 * Compteur de modification `seq` (voir docs/specs, § synchronisation boss → employés).
 *
 * Seul le téléphone du boss attribue des `seq`. Chaque modification d'une ligne partagée
 * (entreprise, comptes, catalogue, clients, exercices, ventes renvoyées…) reçoit la valeur
 * suivante du compteur ; chaque employé retient le dernier `seq` reçu et demande « tout ce
 * qui a changé depuis ».
 */
import type { CoreContext } from '../context';
import { toIso } from '../context';
import type { SqlExecutor } from '../db/types';

/** Crée la ligne du curseur de l'appareil si elle n'existe pas encore. */
export async function ensureSyncState(tx: SqlExecutor, deviceId: string, nowMs: number): Promise<void> {
  await tx.execute(`INSERT INTO sync_state (device_id, last_seq, updated_at) VALUES (?, 0, ?) ON CONFLICT (device_id) DO NOTHING`, [
    deviceId,
    toIso(nowMs),
  ]);
}

/**
 * Prend la valeur suivante du compteur, à appeler dans la transaction qui modifie la ligne.
 * Renvoie `null` sur un téléphone d'employé : c'est le boss qui attribuera le `seq` à la réception.
 */
export async function nextSeq(ctx: Pick<CoreContext, 'device' | 'clock'>, tx: SqlExecutor): Promise<number | null> {
  if (!ctx.device.isBoss) return null;
  const { rows } = await tx.execute(
    `UPDATE sync_state SET last_seq = last_seq + 1, updated_at = ? WHERE device_id = ? RETURNING last_seq`,
    [toIso(ctx.clock.now()), ctx.device.id],
  );
  const value = rows[0]?.last_seq;
  if (value === undefined) {
    throw new Error(`Curseur de synchro absent pour l'appareil ${ctx.device.id} : appeler ensureSyncState à l'initialisation.`);
  }
  return Number(value);
}
