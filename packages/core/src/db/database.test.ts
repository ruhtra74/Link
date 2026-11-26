import { describe, expect, it } from 'vitest';

import { openNodeSqlite } from '../testing/node-sqlite';

describe('Database (adaptateur node:sqlite)', () => {
  it('valide une transaction réussie', async () => {
    const db = openNodeSqlite();
    await db.execute('CREATE TABLE t (v INTEGER)');
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (?)', [1]);
      await tx.execute('INSERT INTO t VALUES (?)', [2]);
    });
    expect((await db.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(2);
  });

  it('annule toute la transaction si une erreur survient', async () => {
    const db = openNodeSqlite();
    await db.execute('CREATE TABLE t (v INTEGER)');
    await expect(
      db.transaction(async (tx) => {
        await tx.execute('INSERT INTO t VALUES (?)', [1]);
        throw new Error('panne au milieu');
      }),
    ).rejects.toThrow('panne au milieu');
    expect((await db.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
  });

  it('fait attendre une requête lancée pendant une transaction (pas de mélange)', async () => {
    const db = openNodeSqlite();
    await db.execute('CREATE TABLE t (v INTEGER)');
    const order: string[] = [];
    const tx = db.transaction(async (t) => {
      await t.execute('INSERT INTO t VALUES (1)');
      await new Promise((r) => setTimeout(r, 20));
      order.push('fin transaction');
      throw new Error('annulée');
    });
    const read = db.execute('SELECT count(*) AS n FROM t').then((r) => {
      order.push('lecture');
      return r.rows[0]?.n;
    });
    await expect(tx).rejects.toThrow('annulée');
    // La lecture voit l'état après l'annulation, jamais la ligne provisoire.
    expect(await read).toBe(0);
    expect(order).toEqual(['fin transaction', 'lecture']);
  });

  it('renvoie les lignes de RETURNING et le nombre de lignes modifiées', async () => {
    const db = openNodeSqlite();
    await db.execute('CREATE TABLE t (v INTEGER)');
    expect((await db.execute('INSERT INTO t VALUES (?) RETURNING v', [7])).rows).toEqual([{ v: 7 }]);
    expect((await db.execute('UPDATE t SET v = v + 1')).changes).toBe(1);
  });
});
