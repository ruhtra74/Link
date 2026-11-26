/**
 * Implémentation de `Database` sur `node:sqlite` (intégré à Node ≥ 22), pour les tests.
 *
 * Ce fichier n'est PAS exporté par `@link/core` : il dépend de Node et ne doit jamais
 * se retrouver dans l'application mobile.
 */
import { DatabaseSync } from 'node:sqlite';

import type { Database, QueryResult, SqlExecutor, SqlValue } from '../db/types';

export function openNodeSqlite(path = ':memory:'): Database {
  const db = new DatabaseSync(path);

  const run = (sql: string, params: readonly SqlValue[] = []): QueryResult => {
    const stmt = db.prepare(sql);
    if (stmt.columns().length > 0) {
      return { rows: stmt.all(...params).map((r) => ({ ...r })) as QueryResult['rows'], changes: 0 };
    }
    return { rows: [], changes: Number(stmt.run(...params).changes) };
  };

  // Une seule connexion : on sérialise les opérations pour qu'une requête lancée
  // pendant une transaction ne s'y mélange pas (même comportement que op-sqlite).
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    execute: (sql, params) => exclusive(async () => run(sql, params)),

    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      exclusive(async () => {
        const tx: SqlExecutor = { execute: async (sql, params) => run(sql, params) };
        run('BEGIN');
        try {
          const result = await fn(tx);
          run('COMMIT');
          return result;
        } catch (error) {
          run('ROLLBACK');
          throw error;
        }
      }),

    close: () => exclusive(async () => db.close()),
  };
}
