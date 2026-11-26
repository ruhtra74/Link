/**
 * Jeu de données (exercice 2026 ouvert le lundi 5 janvier, heure UTC) :
 *
 *  lun. 05 08:00  boss   coupe ×1 (2000) + shampoing ×2 à 2200 (réf. 2500) → lignes 6400, encaissé 6000 (ajustement −400)
 *  lun. 05 10:00  Paul   coupe ×1 à 1500 (réf. 2000)                        → 1500
 *  mar. 06 09:00  Zoé    shampoing ×1                                         → 2500
 *  mar. 06 09:30  boss   gel ×1 — ANNULÉE                                     → ne compte pas
 *  dépenses : lun. 05 loyer 5000 ; mar. 06 électricité 1000
 *
 *  shampoing : prix d'achat 1500 ; coupe : service ; gel : produit sans prix d'achat.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createCategory } from '../catalog/categories';
import { createProduct, createService } from '../catalog/items';
import type { Actor } from '../context';
import { createExpense } from '../expenses/expenses';
import { closeAndOpenFiscalYear, openFiscalYear } from '../fiscal-years/fiscal-years';
import { cancelSale, createSale } from '../sales/sales';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import { getDiscountReport, getEmployeeActivity, getItemPerformance, getMySalesSummary, getRevenueSummary } from './dashboard';

let ctx: TestContext;
let boss: Actor;
let paul: Actor;
let zoe: Actor;
let ids: { coupe: string; shampoing: string; gel: string; soins: string; produits: string };
let year2026: string;

const at = (iso: string) => ctx.clock.set(iso);

beforeEach(async () => {
  ctx = await createTestContext();
  at('2026-01-05T07:00:00.000Z');
  boss = (await bootstrapCompany(ctx)).actor;
  const p = await addEmployee(ctx, boss, 'paul');
  const z = await addEmployee(ctx, boss, 'zoe');
  paul = { ...boss, role: 'EMPLOYEE', userId: p.id };
  zoe = { ...boss, role: 'EMPLOYEE', userId: z.id };
  const soins = (await createCategory(ctx, boss, { name: 'Soins', appliesTo: 'SERVICE' })).id;
  const produits = (await createCategory(ctx, boss, { name: 'Produits', appliesTo: 'PRODUCT' })).id;
  ids = {
    soins,
    produits,
    coupe: (await createService(ctx, boss, { name: 'Coupe', referencePrice: 2000, categoryId: soins })).id,
    shampoing: (await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500, purchasePrice: 1500, categoryId: produits })).id,
    gel: (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id,
  };
  year2026 = (await openFiscalYear(ctx, boss, { name: '2026' })).id;

  at('2026-01-05T08:00:00.000Z');
  await createSale(ctx, boss, {
    lines: [
      { itemId: ids.coupe, quantity: 1 },
      { itemId: ids.shampoing, quantity: 2, unitPrice: 2200 },
    ],
    totalAmount: 6000,
  });
  await createExpense(ctx, boss, { name: 'Loyer', amount: 5000 });
  at('2026-01-05T10:00:00.000Z');
  await createSale(ctx, boss, { lines: [{ itemId: ids.coupe, quantity: 1, unitPrice: 1500 }], employeeId: paul.userId });
  at('2026-01-06T09:00:00.000Z');
  await createSale(ctx, boss, { lines: [{ itemId: ids.shampoing, quantity: 1 }], employeeId: zoe.userId });
  await createExpense(ctx, boss, { name: 'Électricité', amount: 1000 });
  at('2026-01-06T09:30:00.000Z');
  const cancelled = await createSale(ctx, boss, { lines: [{ itemId: ids.gel, quantity: 1 }] });
  await cancelSale(ctx, boss, cancelled.id, 'erreur');
  at('2026-01-06T12:00:00.000Z');
});

describe("chiffre d'affaires et bénéfice", () => {
  it("sur tout l'exercice", async () => {
    expect(await getRevenueSummary(ctx, boss)).toMatchObject({
      fiscalYearId: year2026,
      period: null,
      salesCount: 3,
      revenue: 10_000,
      productsRevenue: 6_900,
      servicesRevenue: 3_500,
      adjustments: -400,
      costOfGoodsSold: 4_500,
      expenses: 6_000,
      profit: -500,
      previous: null,
    });
  });

  it("aujourd'hui, comparé à hier", async () => {
    const today = await getRevenueSummary(ctx, boss, { period: { preset: 'TODAY' } });
    expect(today).toMatchObject({ salesCount: 1, revenue: 2_500, productsRevenue: 2_500, servicesRevenue: 0, costOfGoodsSold: 1_500, expenses: 1_000, profit: 0 });
    expect(today.previous).toMatchObject({ salesCount: 2, revenue: 7_500, revenueChangePercent: -66.7, period: { fromDate: '2026-01-05' } });
  });

  it('sur des dates choisies', async () => {
    expect(await getRevenueSummary(ctx, boss, { period: { from: '2026-01-05', to: '2026-01-05' } })).toMatchObject({
      revenue: 7_500,
      expenses: 5_000,
    });
  });

  it("compte les ventes du jour selon l'heure locale de l'appareil", async () => {
    ctx.clock.setUtcOffset(60); // Douala
    at('2026-01-06T23:30:00.000Z'); // 0 h 30 le 7 à Douala
    await createSale(ctx, boss, { lines: [{ itemId: ids.coupe, quantity: 1 }] });
    const today = await getRevenueSummary(ctx, boss, { period: { preset: 'TODAY' } });
    expect(today).toMatchObject({ salesCount: 1, revenue: 2_000, period: { fromDate: '2026-01-07' } });
  });

  it("un exercice clos reste consultable ; le nouvel exercice repart de zéro", async () => {
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    expect(await getRevenueSummary(ctx, boss)).toMatchObject({ salesCount: 0, revenue: 0, expenses: 0, profit: 0 });
    expect((await getRevenueSummary(ctx, boss, { fiscalYearId: year2026 })).revenue).toBe(10_000);
  });

  it("sans exercice ouvert ni exercice demandé : erreur claire", async () => {
    const fresh = await createTestContext();
    const { actor } = await bootstrapCompany(fresh);
    await expect(getRevenueSummary(fresh, actor)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
    await expect(getRevenueSummary(ctx, boss, { fiscalYearId: 'inconnu' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('est réservé au boss', async () => {
    await expect(getRevenueSummary(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getEmployeeActivity(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getItemPerformance(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getDiscountReport(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('activité des employés', () => {
  it("nombre de ventes, chiffre et part de chacun ; le boss compte comme un producteur", async () => {
    expect(
      (await getEmployeeActivity(ctx, boss)).map((a) => [a.firstName, a.role, a.salesCount, a.revenue, a.sharePercent]),
    ).toEqual([
      ['Awa', 'BOSS', 1, 6_000, 60],
      ['Zoe', 'EMPLOYEE', 1, 2_500, 25],
      ['Paul', 'EMPLOYEE', 1, 1_500, 15],
    ]);
  });

  it('les employés actifs sans vente apparaissent avec zéro', async () => {
    const today = await getEmployeeActivity(ctx, boss, { period: { preset: 'TODAY' } });
    expect(today.map((a) => [a.firstName, a.revenue, a.sharePercent])).toEqual([
      ['Zoe', 2_500, 100],
      ['Awa', 0, 0],
      ['Paul', 0, 0],
    ]);
  });
});

describe('produits et services', () => {
  it('classement des articles vendus, articles non vendus, détail par catégorie', async () => {
    const perf = await getItemPerformance(ctx, boss);
    expect(perf.sold.map((s) => [s.name, s.quantity, s.revenue])).toEqual([
      ['Shampoing', 3, 6_900],
      ['Coupe', 2, 3_500],
    ]);
    expect(perf.notSold.map((s) => s.name)).toEqual(['Gel']); // sa seule vente est annulée
    expect(perf.byCategory.map((c) => [c.name, c.quantity, c.revenue])).toEqual([
      ['Produits', 3, 6_900],
      ['Soins', 2, 3_500],
    ]);
  });
});

describe('remises et prix négociés', () => {
  it('remises sur les lignes, majorations, remises sur le total, par employé et par article', async () => {
    expect(await getDiscountReport(ctx, boss)).toEqual({
      lineDiscounts: 1_100,
      lineMarkups: 0,
      totalDiscounts: 400,
      byEmployee: [
        { userId: boss.userId, firstName: 'Awa', lastName: 'Diallo', discount: 1_000 },
        { userId: paul.userId, firstName: 'Paul', lastName: 'Mbarga', discount: 500 },
      ],
      byItem: [
        { itemId: ids.shampoing, name: 'Shampoing', discount: 600 },
        { itemId: ids.coupe, name: 'Coupe', discount: 500 },
      ],
    });
  });

  it('compte les majorations', async () => {
    await createSale(ctx, boss, { lines: [{ itemId: ids.coupe, quantity: 2, unitPrice: 2500 }] });
    expect((await getDiscountReport(ctx, boss, { period: { preset: 'TODAY' } })).lineMarkups).toBe(1_000);
  });
});

describe('récapitulatif personnel', () => {
  it("l'employé voit ses ventes du jour, de la semaine et du mois (en attente comprises, annulées exclues)", async () => {
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.userId);
    const me = { ...paul, deviceId: paulPhone.device.id };
    await createSale(paulPhone, me, { lines: [{ itemId: ids.coupe, quantity: 1 }] }); // aujourd'hui, en attente
    const s = await createSale(paulPhone, me, { lines: [{ itemId: ids.coupe, quantity: 1 }] });
    await cancelSale(paulPhone, me, s.id, 'erreur');
    expect(await getMySalesSummary(paulPhone, me)).toEqual({
      today: { salesCount: 1, total: 2_000 },
      week: { salesCount: 2, total: 3_500 }, // + la vente de lundi saisie par le boss pour lui
      month: { salesCount: 2, total: 3_500 },
    });
  });
});
