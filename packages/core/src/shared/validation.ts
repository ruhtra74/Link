/**
 * Validations simples et partagées. Chaque échec lève une DomainError 'VALIDATION'
 * avec le nom du champ, que l'application affiche à côté du champ concerné.
 */
import { DomainError } from '../errors';

const fail = (field: string, message: string): never => {
  throw new DomainError('VALIDATION', message, { field });
};

/** Texte obligatoire : espaces retirés, non vide, longueur maximale. */
export function requiredText(field: string, value: string | undefined | null, max = 100): string {
  const v = (value ?? '').trim();
  if (!v) fail(field, `Le champ « ${field} » est obligatoire.`);
  if (v.length > max) fail(field, `Le champ « ${field} » dépasse ${max} caractères.`);
  return v;
}

/** Texte facultatif : `null` si vide. */
export function optionalText(field: string, value: string | undefined | null, max = 200): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.length > max) fail(field, `Le champ « ${field} » dépasse ${max} caractères.`);
  return v;
}

/**
 * Identifiant de connexion : 3 à 30 caractères, lettres minuscules non accentuées, chiffres,
 * point, tiret et souligné. Mis en minuscules : « Awa » et « awa » sont le même identifiant.
 */
export function login(value: string | undefined | null): string {
  const v = (value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(v)) {
    fail('login', "L'identifiant doit faire 3 à 30 caractères : lettres sans accent, chiffres, point, tiret ou souligné.");
  }
  return v;
}

export const PASSWORD_MIN_LENGTH = 6;

export function password(field: string, value: string | undefined | null): string {
  const v = value ?? '';
  if (v.length < PASSWORD_MIN_LENGTH) fail(field, `Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`);
  if (v.length > 128) fail(field, 'Le mot de passe dépasse 128 caractères.');
  return v;
}

/** Couleur au format #RRGGBB, ou `null`. */
export function color(field: string, value: string | undefined | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) fail(field, 'La couleur doit être au format #RRGGBB.');
  return v.toUpperCase();
}

export function integerInRange(field: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, `La valeur doit être un entier entre ${min} et ${max}.`);
  return value;
}

export function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) fail(field, `Valeur invalide : ${value}.`);
  return value as T;
}
