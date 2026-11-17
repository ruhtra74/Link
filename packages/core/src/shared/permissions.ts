import type { Actor, CoreContext } from '../context';
import { DomainError } from '../errors';

export function requireBoss(actor: Actor): void {
  if (actor.role !== 'BOSS') throw new DomainError('FORBIDDEN', 'Action réservée au boss.');
}

/** Certaines actions n'ont de sens que sur le téléphone du boss, centre de l'entreprise (exercices, dépenses…). */
export function requireBossDevice(ctx: Pick<CoreContext, 'device'>): void {
  if (!ctx.device.isBoss) throw new DomainError('FORBIDDEN', 'Action possible uniquement sur le téléphone du boss.');
}
