import { describe, expect, it } from 'vitest';

import { openNodeSqlite } from '../testing/node-sqlite';
import { prepareDatabase, schemaVersion } from './migrate';
import { migrations } from './migrations';

const EXPECTED_TABLES = [
  'alert',
  'audit_log',
  'backup',
  'burst_template',
  'burst_template_line',
  'category',
  'change_log',
  'company',
  'customer',
  'device',
  'expense',
  'fiscal_year',
  'item',
  'item_cost',
  'payment_method',
  'sale',
  'sale_line',
  'stock_movement',
  'sync_log',
  'sync_state',
  'user',
];

describe('prepareDatabase', () => {
  it('crée toutes les tables du modèle de données sur une base vide', async () => {
    const db = openNodeSqlite();
    expect(await prepareDatabase(db)).toBe(migrations.length);
    const { rows } = await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_TABLES);
  });

  it('active les clés étrangères', async () => {
    const db = openNodeSqlite();
    await prepareDatabase(db);
    expect((await db.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(1);
  });

  it('ne réapplique rien si la base est à jour', async () => {
    const db = openNodeSqlite();
    await prepareDatabase(db);
    await expect(prepareDatabase(db)).resolves.toBe(migrations.length);
  });

  it('applique seulement les migrations manquantes', async () => {
    const db = openNodeSqlite();
    const extra = [...migrations, { version: migrations.length + 1, name: 'test', statements: ['CREATE TABLE extra (x)'] }];
    await prepareDatabase(db);
    expect(await prepareDatabase(db, extra)).toBe(migrations.length + 1);
    expect((await db.execute(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'extra'`)).rows[0]?.n).toBe(1);
  });

  it('annule entièrement une migration qui échoue et garde la version précédente', async () => {
    const db = openNodeSqlite();
    await prepareDatabase(db);
    const broken = [
      ...migrations,
      { version: migrations.length + 1, name: 'cassée', statements: ['CREATE TABLE a_moitie (x)', 'CECI N EST PAS DU SQL'] },
    ];
    await expect(prepareDatabase(db, broken)).rejects.toThrow();
    expect(await schemaVersion(db)).toBe(migrations.length);
    expect((await db.execute(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'a_moitie'`)).rows[0]?.n).toBe(0);
  });

  it("refuse une base plus récente que l'application", async () => {
    const db = openNodeSqlite();
    await db.execute('PRAGMA user_version = 99');
    await expect(prepareDatabase(db)).rejects.toThrow(/plus récente/);
  });

  it('refuse des migrations mal numérotées', async () => {
    const db = openNodeSqlite();
    await expect(prepareDatabase(db, [{ version: 2, name: 'x', statements: [] }])).rejects.toThrow(/mal numérotées/);
  });
});
