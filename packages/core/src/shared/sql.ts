import type { Row, SqlValue } from '../db/types';

/** Booléen → 0/1 pour SQLite. */
export const toDb = (b: boolean) => (b ? 1 : 0);

export const str = (row: Row, key: string): string => String(row[key]);
export const strOrNull = (row: Row, key: string): string | null => (row[key] == null ? null : String(row[key]));
export const num = (row: Row, key: string): number => Number(row[key]);
export const bool = (row: Row, key: string): boolean => Number(row[key]) === 1;

/**
 * Construit `SET a = ?, b = ?` à partir des seuls champs fournis (les `undefined` sont ignorés).
 * Les noms de colonnes viennent toujours du code, jamais de l'utilisateur.
 */
export function setClause(values: Record<string, SqlValue | undefined>): { sql: string; params: SqlValue[] } {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined) as [string, SqlValue][];
  return { sql: entries.map(([k]) => `${k} = ?`).join(', '), params: entries.map(([, v]) => v) };
}
