/**
 * Les règles de la conception portées directement par le schéma (contraintes SQL).
 * Elles protègent la base même si le code applicatif oublie une vérification.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from '../testing/context';
import type { SqlValue } from './types';

const NOW = '2026-01-05T08:00:00.000Z';
let ctx: TestContext;
let companyId: string;
let bossId: string;

const insert = (table: string, values: Record<string, SqlValue>) => {
  const cols = Object.keys(values);
  return ctx.db.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(values));
};

const company = (id: string) => insert('company', { id, name: 'Salon Awa', created_at: NOW, updated_at: NOW });
const user = (id: string, login: string, company = companyId) =>
  insert('user', {
    id,
    company_id: company,
    login,
    password_hash: 'x',
    first_name: 'A',
    last_name: 'B',
    role: 'EMPLOYEE',
    created_at: NOW,
    updated_at: NOW,
  });
const item = (id: string, values: Record<string, SqlValue> = {}) =>
  insert('item', {
    id,
    company_id: companyId,
    type: 'PRODUCT',
    name: 'Shampoing',
    reference_price: 500,
    created_at: NOW,
    updated_at: NOW,
    ...values,
  });
const sale = (id: string, values: Record<string, SqlValue> = {}) =>
  insert('sale', {
    id,
    company_id: companyId,
    employee_id: bossId,
    entered_by_id: bossId,
    device_id: 'appareil',
    occurred_at: NOW,
    reference_total: 500,
    total_amount: 500,
    created_at: NOW,
    updated_at: NOW,
    ...values,
  });
const line = (id: string, saleId: string, itemId: string) =>
  insert('sale_line', {
    id,
    sale_id: saleId,
    item_id: itemId,
    item_name: 'Shampoing',
    item_type: 'PRODUCT',
    quantity: 1,
    reference_price: 500,
    unit_price: 500,
    line_total: 500,
    price_gap: 0,
  });
const year = (id: string, status: 'OPEN' | 'CLOSED') =>
  insert('fiscal_year', {
    id,
    company_id: companyId,
    name: id,
    status,
    opened_at: NOW,
    closed_at: status === 'CLOSED' ? NOW : null,
  });

beforeEach(async () => {
  ctx = await createTestContext();
  companyId = ctx.ids.newId();
  bossId = ctx.ids.newId();
  await company(companyId);
  await user(bossId, 'boss');
});

describe('schéma : entreprise et comptes', () => {
  it("n'accepte que le franc CFA", async () => {
    await expect(insert('company', { id: 'c2', name: 'X', currency: 'EUR', created_at: NOW, updated_at: NOW })).rejects.toThrow(
      /CHECK/,
    );
  });

  it('impose un identifiant de connexion unique dans une entreprise', async () => {
    await expect(user('u2', 'boss')).rejects.toThrow(/UNIQUE/);
  });

  it('autorise le même identifiant dans une autre entreprise', async () => {
    await company('autre');
    await expect(user('u3', 'boss', 'autre')).resolves.toBeDefined();
  });
});

describe('schéma : exercices', () => {
  it("n'autorise qu'un seul exercice ouvert par entreprise", async () => {
    await year('2026', 'OPEN');
    await expect(year('2027', 'OPEN')).rejects.toThrow(/UNIQUE/);
  });

  it('autorise plusieurs exercices clos et un ouvert', async () => {
    await year('2024', 'CLOSED');
    await year('2025', 'CLOSED');
    await expect(year('2026', 'OPEN')).resolves.toBeDefined();
  });

  it('exige une date de clôture pour un exercice clos', async () => {
    await expect(
      insert('fiscal_year', { id: 'y', company_id: companyId, name: 'y', status: 'CLOSED', opened_at: NOW }),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('schéma : catalogue et stock', () => {
  it("interdit le suivi de stock pour un service", async () => {
    await expect(item('s', { type: 'SERVICE', is_stock_tracked: 1 })).rejects.toThrow(/CHECK/);
  });

  it('refuse un prix négatif', async () => {
    await expect(item('p', { reference_price: -1 })).rejects.toThrow(/CHECK/);
  });

  it('accepte un stock négatif (la vente n’est jamais bloquée)', async () => {
    await expect(item('p', { is_stock_tracked: 1, stock_quantity: -3 })).resolves.toBeDefined();
  });

  it('impose la forme des mouvements : un comptage a une quantité comptée, les autres une variation', async () => {
    await item('p', { is_stock_tracked: 1 });
    const base = { company_id: companyId, item_id: 'p', occurred_at: NOW, user_id: bossId, created_at: NOW };
    await expect(insert('stock_movement', { id: 'm1', ...base, type: 'INVENTORY', counted_quantity: 10 })).resolves.toBeDefined();
    await expect(insert('stock_movement', { id: 'm2', ...base, type: 'INVENTORY', quantity_delta: 10 })).rejects.toThrow(/CHECK/);
    await expect(insert('stock_movement', { id: 'm3', ...base, type: 'ENTRY', quantity_delta: 20 })).resolves.toBeDefined();
    await expect(insert('stock_movement', { id: 'm4', ...base, type: 'ENTRY', counted_quantity: 20 })).rejects.toThrow(/CHECK/);
  });

  it("ne crée qu'un seul mouvement de vente par ligne de vente (renvoi en double sans effet)", async () => {
    await item('p', { is_stock_tracked: 1 });
    await sale('v');
    await line('l', 'v', 'p');
    const mv = (id: string) =>
      insert('stock_movement', {
        id,
        company_id: companyId,
        item_id: 'p',
        type: 'SALE',
        quantity_delta: -1,
        occurred_at: NOW,
        sale_line_id: 'l',
        user_id: bossId,
        created_at: NOW,
      });
    await mv('m1');
    await expect(mv('m2')).rejects.toThrow(/UNIQUE/);
  });
});

describe('schéma : ventes', () => {
  it('exige un motif, un auteur et une date pour une vente annulée', async () => {
    await expect(sale('v', { status: 'CANCELLED' })).rejects.toThrow(/CHECK/);
    await expect(
      sale('v2', { status: 'CANCELLED', cancel_reason: 'erreur de saisie', cancelled_by: bossId, cancelled_at: NOW }),
    ).resolves.toBeDefined();
  });

  it('refuse une quantité nulle ou négative', async () => {
    await item('p');
    await sale('v');
    await expect(
      insert('sale_line', {
        id: 'l',
        sale_id: 'v',
        item_id: 'p',
        item_name: 'x',
        item_type: 'PRODUCT',
        quantity: 0,
        reference_price: 1,
        unit_price: 1,
        line_total: 0,
        price_gap: 0,
      }),
    ).rejects.toThrow(/CHECK/);
  });

  it("accepte une vente dont l'employé et l'appareil ne sont pas présents localement (téléphone d'employé)", async () => {
    // Vente saisie par le boss au nom de l'employé : ni le compte ni l'appareil du boss n'existent chez l'employé.
    await expect(sale('v', { employee_id: 'employe-absent', entered_by_id: 'boss-absent', device_id: 'appareil-boss' })).resolves.toBeDefined();
  });

  it('vérifie les clés étrangères à la fin de la transaction : ordre libre pendant une synchro', async () => {
    await item('p');
    await ctx.db.transaction(async (tx) => {
      // La ligne arrive avant sa vente.
      await tx.execute(
        `INSERT INTO sale_line (id, sale_id, item_id, item_name, item_type, quantity, reference_price, unit_price, line_total, price_gap)
         VALUES ('l', 'v', 'p', 'x', 'PRODUCT', 1, 500, 500, 500, 0)`,
      );
      await tx.execute(
        `INSERT INTO sale (id, company_id, employee_id, entered_by_id, device_id, occurred_at, reference_total, total_amount, created_at, updated_at)
         VALUES ('v', ?, 'e', 'e', 'd', ?, 500, 500, ?, ?)`,
        [companyId, NOW, NOW, NOW],
      );
    });
    expect((await ctx.db.execute('SELECT count(*) AS n FROM sale_line')).rows[0]?.n).toBe(1);
  });

  it('refuse au COMMIT une ligne dont la vente n’existe pas', async () => {
    await item('p');
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO sale_line (id, sale_id, item_id, item_name, item_type, quantity, reference_price, unit_price, line_total, price_gap)
           VALUES ('l', 'vente-inexistante', 'p', 'x', 'PRODUCT', 1, 500, 500, 500, 0)`,
        );
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect((await ctx.db.execute('SELECT count(*) AS n FROM sale_line')).rows[0]?.n).toBe(0);
  });

  it('supprime les lignes avec leur vente (mode disparition chez l’employé)', async () => {
    await item('p');
    await sale('v');
    await line('l1', 'v', 'p');
    await line('l2', 'v', 'p');
    await ctx.db.execute(`DELETE FROM sale WHERE id = 'v'`);
    expect((await ctx.db.execute('SELECT count(*) AS n FROM sale_line')).rows[0]?.n).toBe(0);
  });
});

describe('schéma : dépenses', () => {
  it('exige un exercice et un montant strictement positif', async () => {
    await year('2026', 'OPEN');
    const base = { id: 'd', company_id: companyId, name: 'Loyer', expense_date: '2026-01-05', created_by: bossId, created_at: NOW, updated_at: NOW };
    await expect(insert('expense', { ...base, amount: 50_000 })).rejects.toThrow(/NOT NULL/);
    await expect(insert('expense', { ...base, fiscal_year_id: '2026', amount: 0 })).rejects.toThrow(/CHECK/);
    await expect(insert('expense', { ...base, fiscal_year_id: '2026', amount: 50_000 })).resolves.toBeDefined();
  });
});
