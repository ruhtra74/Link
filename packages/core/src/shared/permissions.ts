import type { Actor } from '../context';
import { DomainError } from '../errors';

export function requireBoss(actor: Actor): void {
  if (actor.role !== 'BOSS') throw new DomainError('FORBIDDEN', 'Action réservée au boss.');
}
