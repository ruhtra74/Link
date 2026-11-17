/**
 * Ce dont le cœur métier a besoin pour fonctionner, fourni par l'application
 * (ou par les tests) : la base, l'horloge, les identifiants et l'appareil courant.
 * Rien n'est lu « en douce » (pas de Date.now() ni de Math.random() dans le cœur),
 * ce qui rend chaque règle testable de façon déterministe.
 */
import type { Database } from './db/types';
import type { IdGenerator } from './ids';

export interface Clock {
  /** Instant courant, en millisecondes depuis l'époque Unix (UTC). */
  now(): number;
}

/** Horodatage ISO 8601 en UTC, format de toutes les dates stockées. */
export const toIso = (ms: number) => new Date(ms).toISOString();

export type Role = 'BOSS' | 'EMPLOYEE';

/** Qui effectue une action. Chaque commande métier le reçoit et vérifie ses droits. */
export interface Actor {
  userId: string;
  companyId: string;
  role: Role;
  /** Appareil sur lequel l'action est faite. */
  deviceId: string;
}

export interface CoreContext {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
  /** L'appareil sur lequel tourne ce cœur. Le téléphone du boss attribue les `seq`. */
  device: { id: string; isBoss: boolean };
}
