/**
 * Accès à la base de données, indépendant de la plateforme.
 *
 * Le cœur métier n'utilise que ces interfaces. Deux implémentations :
 * - `node:sqlite` pour les tests sur ordinateur (voir `testing/node-sqlite.ts`) ;
 * - op-sqlite (SQLCipher) dans l'application mobile (phase 2).
 *
 * L'interface est asynchrone : dans l'app, les requêtes s'exécutent hors du fil
 * de l'interface, qui reste fluide même pendant la réception d'une synchro.
 */

/** Valeurs acceptées en paramètre et renvoyées par SQLite. Les booléens sont stockés en 0/1. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type Row = Record<string, SqlValue>;

export type QueryResult = {
  /** Lignes renvoyées (SELECT ou `RETURNING`). */
  rows: Row[];
  /** Nombre de lignes modifiées. Renseigné pour les écritures sans `RETURNING`, 0 sinon. */
  changes: number;
};

/** Exécute une requête SQL paramétrée (`?`). */
export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<QueryResult>;
}

export interface Database extends SqlExecutor {
  /**
   * Exécute `fn` dans une transaction : tout est validé, ou tout est annulé si `fn` lève une erreur.
   *
   * Les requêtes de la transaction passent par `tx`, jamais par la base elle-même
   * (sinon elles attendraient la fin de la transaction : blocage). Les transactions
   * ne s'imbriquent pas.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
