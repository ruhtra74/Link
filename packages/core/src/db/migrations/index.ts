import { migration0001 } from './0001_initial';
import type { Migration } from './types';

/** Toutes les migrations, dans l'ordre. Ne jamais modifier une migration déjà publiée : en ajouter une nouvelle. */
export const migrations: readonly Migration[] = [migration0001];

export type { Migration } from './types';
