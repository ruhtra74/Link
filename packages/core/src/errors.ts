/**
 * Erreurs métier. Chaque erreur porte un code stable, que l'application traduit
 * en message pour l'utilisateur (français, anglais).
 */
export type ErrorCode =
  /** Identifiant ou mot de passe incorrect. Volontairement sans préciser lequel. */
  | 'UNAUTHENTICATED'
  /** Action interdite pour ce rôle ou dans cet état (ex. employé qui modifie une vente synchronisée). */
  | 'FORBIDDEN'
  /** Élément introuvable. */
  | 'NOT_FOUND'
  /** Donnée invalide (montant négatif, champ obligatoire vide…). */
  | 'VALIDATION'
  /** Aucun exercice ouvert : vente, dépense et synchronisation impossibles chez le boss. */
  | 'NO_OPEN_FISCAL_YEAR'
  /** Conflit avec l'état existant (identifiant déjà pris, exercice déjà ouvert…). */
  | 'CONFLICT';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const isDomainError = (e: unknown, code?: ErrorCode): e is DomainError =>
  e instanceof DomainError && (code === undefined || e.code === code);
