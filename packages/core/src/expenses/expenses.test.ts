import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../context';
import { closeAndOpenFiscalYear, openFiscalYear } from '../fiscal-years/fiscal-years';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import { cancelExpense, createExpense, getExpense, listExpenses, updateExpense } from './expenses';

let ctx: TestContext;
let boss: Actor;
let paul: Actor;
beforeEach(async () => {
  ctx = await createTestContext(); // 2026-01-05T08:00Z
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paul = { ...boss, role: 'EMPLOYEE', userId: employee.id };
});

const loyer = { name: 'Loyer janvier', amount: 50_000 };

describe('saisie', () => {
  it("exige un exercice ouvert et s'y rattache ; date du jour par défaut", async () => {
    await expect(createExpense(ctx, boss, loyer)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
    const year = await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, { ...loyer, description: 'Local du salon' });
    expect(e).toMatchObject({
      fiscalYearId: year.id,
      name: 'Loyer janvier',
      description: 'Local du salon',
      amount: 50_000,
      expenseDate: '2026-01-05',
      status: 'ACTIVE',
      createdBy: boss.userId,
    });
  });

  it("« aujourd'hui » est la date locale du téléphone, pas la date UTC", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    ctx.clock.set('2026-01-05T23:30:00.000Z');
    ctx.clock.setUtcOffset(60); // Douala : il est déjà 0 h 30 le 6 janvier
    expect((await createExpense(ctx, boss, loyer)).expenseDate).toBe('2026-01-06');
  });

  it('accepte une date passée ; refuse une date future ou invalide', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    expect((await createExpense(ctx, boss, { ...loyer, expenseDate: '2026-01-02' })).expenseDate).toBe('2026-01-02');
    for (const expenseDate of ['2026-01-06', '2026-02-30', '05/01/2026']) {
      await expect(createExpense(ctx, boss, { ...loyer, expenseDate })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'expenseDate' } });
    }
  });

  it('exige un nom et un montant entier strictement positif', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    await expect(createExpense(ctx, boss, { name: '', amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'name' } });
    for (const amount of [0, -5, 99.5]) {
      await expect(createExpense(ctx, boss, { name: 'X', amount })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'amount' } });
    }
  });

  it("est réservée au boss, sur son téléphone", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.userId);
    await expect(createExpense(ctx, paul, loyer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createExpense(paulPhone, boss, loyer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("n'a pas de seq : une dépense n'est jamais envoyée aux employés", async () => {
    const columns = (await ctx.db.execute('PRAGMA table_info(expense)')).rows.map((r) => r.name);
    expect(columns).not.toContain('seq');
  });
});

describe('modification et annulation', () => {
  it('le boss modifie une dépense', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, loyer);
    expect(await updateExpense(ctx, boss, e.id, { amount: 55_000, description: 'augmentation' })).toMatchObject({
      amount: 55_000,
      description: 'augmentation',
      name: 'Loyer janvier',
    });
  });

  it("l'annulation exige un motif, garde la dépense et la sort du total", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const a = await createExpense(ctx, boss, loyer);
    await createExpense(ctx, boss, { name: 'Électricité', amount: 12_000 });
    await expect(cancelExpense(ctx, boss, a.id, ' ')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await cancelExpense(ctx, boss, a.id, 'saisie en double')).toMatchObject({ status: 'CANCELLED', cancelReason: 'saisie en double' });
    expect((await listExpenses(ctx, boss)).total).toBe(12_000);
  });

  it('une dépense annulée ne se modifie plus', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, loyer);
    await cancelExpense(ctx, boss, e.id, 'erreur');
    await expect(updateExpense(ctx, boss, e.id, { amount: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(cancelExpense(ctx, boss, e.id, 'encore')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("une dépense d'un exercice clos est en lecture seule", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, loyer);
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    await expect(updateExpense(ctx, boss, e.id, { amount: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(cancelExpense(ctx, boss, e.id, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('signale une dépense inconnue', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    await expect(updateExpense(ctx, boss, 'inconnue', { amount: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('consultation', () => {
  it("liste les dépenses de l'exercice ouvert (les plus récentes d'abord) avec leur total", async () => {
    const first = await openFiscalYear(ctx, boss, { name: '2026' });
    await createExpense(ctx, boss, { name: 'Ancienne', amount: 1_000 });
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    ctx.clock.set('2026-03-10T09:00:00.000Z');
    await createExpense(ctx, boss, { name: 'Loyer', amount: 50_000, expenseDate: '2026-03-01' });
    await createExpense(ctx, boss, { name: 'Chaise cassée', amount: 15_000 });

    const current = await listExpenses(ctx, boss);
    expect(current.expenses.map((e) => e.name)).toEqual(['Chaise cassée', 'Loyer']);
    expect(current.total).toBe(65_000);
    // Un exercice clos reste consultable.
    expect((await listExpenses(ctx, boss, { fiscalYearId: first.id })).total).toBe(1_000);
  });

  it('inclut les dépenses annulées sur demande, sans les compter', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, loyer);
    await cancelExpense(ctx, boss, e.id, 'erreur');
    expect(await listExpenses(ctx, boss)).toEqual({ expenses: [], total: 0 });
    expect(await listExpenses(ctx, boss, { includeCancelled: true })).toMatchObject({ expenses: [{ status: 'CANCELLED' }], total: 0 });
  });

  it("sans exercice ouvert : liste vide ; consultation réservée au boss", async () => {
    expect(await listExpenses(ctx, boss)).toEqual({ expenses: [], total: 0 });
    await openFiscalYear(ctx, boss, { name: '2026' });
    const e = await createExpense(ctx, boss, loyer);
    await expect(listExpenses(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getExpense(ctx, paul, e.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
