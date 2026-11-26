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
  /**
   * Décalage de l'heure locale de l'appareil par rapport à UTC, en minutes, à un instant donné
   * (ex. +60 à Douala, 0 à Dakar). Dans l'app : `-new Date(ms).getTimezoneOffset()`.
   * Sert à savoir quel jour il est pour l'utilisateur (« aujourd'hui », ventes du jour…).
   */
  utcOffsetMinutes(atMs: number): number;
}

/** Horodatage ISO 8601 en UTC, format de toutes les dates stockées. */
export const toIso = (ms: number) => new Date(ms).toISOString();

/** Date locale (AAAA-MM-JJ) de l'utilisateur à un instant donné. */
export const localDate = (clock: Clock, ms: number): string =>
  new Date(ms + clock.utcOffsetMinutes(ms) * 60_000).toISOString().slice(0, 10);

export type Role = 'BOSS' | 'EMPLOYEE';

/** Qui effectue une action. Chaque commande métier le reçoit et vérifie ses droits. */
export interface Actor {
  userId: string;
  companyId: string;
  role: Role;
  /** Appareil sur lequel l'action est faite. */
  deviceId: string;
}

/**
 * Hachage des mots de passe. Dans l'app : Argon2id (3 passes, 64 Mo) via libsodium,
 * résultat encodé avec son sel et ses paramètres. Dans les tests : une version factice rapide.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface CoreContext {
  db: Database;
  clock: Clock;
  ids: IdGenerator;
  passwords: PasswordHasher;
  /** L'appareil sur lequel tourne ce cœur. Le téléphone du boss attribue les `seq`. */
  device: { id: string; isBoss: boolean };
}
