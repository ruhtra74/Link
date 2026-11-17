import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../context';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import { createCategory, listCategories, updateCategory } from './categories';
import {
  createProduct,
  createService,
  getItem,
  getPurchasePrices,
  listItems,
  setItemArchived,
  setPurchasePrice,
  updateItem,
} from './items';

let ctx: TestContext;
let boss: Actor;
let paul: Actor;
beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paul = { ...boss, role: 'EMPLOYEE', userId: employee.id };
});

describe('catégories', () => {
  it('le boss crée des catégories, listées par nom', async () => {
    await createCategory(ctx, boss, { name: 'Soins', appliesTo: 'SERVICE' });
    await createCategory(ctx, boss, { name: 'Accessoires', appliesTo: 'PRODUCT' });
    expect((await listCategories(ctx, paul)).map((c) => c.name)).toEqual(['Accessoires', 'Soins']);
  });

  it('une catégorie désactivée disparaît de la saisie mais reste visible en gestion', async () => {
    const c = await createCategory(ctx, boss, { name: 'Ancienne', appliesTo: 'BOTH' });
    await updateCategory(ctx, boss, c.id, { isActive: false });
    expect(await listCategories(ctx, boss)).toEqual([]);
    expect((await listCategories(ctx, boss, { includeInactive: true })).map((x) => x.name)).toEqual(['Ancienne']);
  });

  it("refuse de restreindre la portée si des articles de l'autre type y sont classés", async () => {
    const c = await createCategory(ctx, boss, { name: 'Tout', appliesTo: 'BOTH' });
    await createService(ctx, boss, { name: 'Coupe', referencePrice: 2000, categoryId: c.id });
    await expect(updateCategory(ctx, boss, c.id, { appliesTo: 'PRODUCT' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateCategory(ctx, boss, c.id, { appliesTo: 'SERVICE' })).resolves.toMatchObject({ appliesTo: 'SERVICE' });
  });

  it('est réservée au boss', async () => {
    await expect(createCategory(ctx, paul, { name: 'X', appliesTo: 'BOTH' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('produits et services', () => {
  it('crée un produit avec référence interne et prix d’achat', async () => {
    const p = await createProduct(ctx, boss, { name: 'Shampoing 250 ml', referencePrice: 2500, internalRef: 'SH-250', purchasePrice: 1500 });
    expect(p).toMatchObject({ type: 'PRODUCT', referencePrice: 2500, internalRef: 'SH-250', durationMinutes: null, isStockTracked: false, isArchived: false });
    expect(await getPurchasePrices(ctx, boss)).toEqual({ [p.id]: 1500 });
  });

  it('crée un service avec une durée indicative, sans prix d’achat ni stock', async () => {
    const s = await createService(ctx, boss, { name: 'Coupe homme', referencePrice: 2000, durationMinutes: 30 });
    expect(s).toMatchObject({ type: 'SERVICE', durationMinutes: 30, internalRef: null, isStockTracked: false });
    await expect(setPurchasePrice(ctx, boss, s.id, 500)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("vérifie que la catégorie accepte ce type d'article", async () => {
    const soins = await createCategory(ctx, boss, { name: 'Soins', appliesTo: 'SERVICE' });
    await expect(createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000, categoryId: soins.id })).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { field: 'categoryId' },
    });
    await expect(createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000, categoryId: 'inconnue' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.each([
    ['prix négatif', -100],
    ['prix à virgule (FCFA entiers)', 99.5],
  ])('refuse un %s', async (_, referencePrice) => {
    await expect(createProduct(ctx, boss, { name: 'X', referencePrice })).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { field: 'referencePrice' },
    });
  });

  it('modifie un article sans changer son type ; refuse les champs de l’autre type', async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 });
    expect(await updateItem(ctx, boss, p.id, { referencePrice: 1200, isFavorite: true })).toMatchObject({ referencePrice: 1200, isFavorite: true, name: 'Gel' });
    await expect(updateItem(ctx, boss, p.id, { durationMinutes: 10 })).rejects.toMatchObject({ code: 'VALIDATION' });
    const s = await createService(ctx, boss, { name: 'Coupe', referencePrice: 2000 });
    await expect(updateItem(ctx, boss, s.id, { internalRef: 'X' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("attribue un nouveau seq à chaque modification (propagation aux employés)", async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 });
    const seq = async () => Number((await ctx.db.execute('SELECT seq FROM item WHERE id = ?', [p.id])).rows[0]?.seq);
    const before = await seq();
    await updateItem(ctx, boss, p.id, { referencePrice: 1100 });
    expect(await seq()).toBeGreaterThan(before);
  });

  it('la gestion du catalogue est réservée au boss, sur son téléphone', async () => {
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.userId);
    await expect(createProduct(ctx, paul, { name: 'X', referencePrice: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createProduct(paulPhone, boss, { name: 'X', referencePrice: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('archivage', () => {
  it('un article archivé disparaît de la saisie mais reste consultable', async () => {
    const p = await createProduct(ctx, boss, { name: 'Ancien gel', referencePrice: 1000 });
    await setItemArchived(ctx, boss, p.id, true);
    expect(await listItems(ctx, paul)).toEqual([]);
    expect((await listItems(ctx, boss, { includeArchived: true })).map((i) => i.name)).toEqual(['Ancien gel']);
    expect((await getItem(ctx, paul, p.id)).isArchived).toBe(true);
    await setItemArchived(ctx, boss, p.id, false);
    expect(await listItems(ctx, paul)).toHaveLength(1);
  });

  it("aucun article n'est supprimé", async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 });
    await setItemArchived(ctx, boss, p.id, true);
    expect((await ctx.db.execute('SELECT count(*) AS n FROM item')).rows[0]?.n).toBe(1);
  });
});

describe('liste et recherche (saisie rapide)', () => {
  beforeEach(async () => {
    const soins = await createCategory(ctx, boss, { name: 'Soins', appliesTo: 'SERVICE' });
    await createService(ctx, boss, { name: 'Coupe homme', referencePrice: 2000, categoryId: soins.id, isFavorite: true });
    await createService(ctx, boss, { name: 'Brushing', referencePrice: 3000, categoryId: soins.id });
    await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500, internalRef: 'SH-250' });
  });

  it('favoris en premier, puis par nom', async () => {
    expect((await listItems(ctx, paul)).map((i) => i.name)).toEqual(['Coupe homme', 'Brushing', 'Shampoing']);
  });

  it('filtre par type, catégorie, favoris et texte (nom ou référence)', async () => {
    expect((await listItems(ctx, paul, { type: 'PRODUCT' })).map((i) => i.name)).toEqual(['Shampoing']);
    expect((await listItems(ctx, paul, { favoritesOnly: true })).map((i) => i.name)).toEqual(['Coupe homme']);
    expect((await listItems(ctx, paul, { search: 'brush' })).map((i) => i.name)).toEqual(['Brushing']);
    expect((await listItems(ctx, paul, { search: 'SH-2' })).map((i) => i.name)).toEqual(['Shampoing']);
    const soins = (await listCategories(ctx, paul))[0]!;
    expect(await listItems(ctx, paul, { categoryId: soins.id })).toHaveLength(2);
  });
});

describe("prix d'achat : boss seulement", () => {
  it('fixe, modifie et efface le prix d’achat', async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 });
    expect(await getPurchasePrices(ctx, boss)).toEqual({});
    await setPurchasePrice(ctx, boss, p.id, 600);
    await setPurchasePrice(ctx, boss, p.id, 650);
    expect(await getPurchasePrices(ctx, boss)).toEqual({ [p.id]: 650 });
    await setPurchasePrice(ctx, boss, p.id, null);
    expect(await getPurchasePrices(ctx, boss)).toEqual({});
  });

  it("n'est jamais accessible à un employé", async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000, purchasePrice: 600 });
    await expect(getPurchasePrices(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setPurchasePrice(ctx, paul, p.id, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // L'article lui-même ne porte jamais le prix d'achat.
    expect(Object.keys(await getItem(ctx, paul, p.id))).not.toContain('purchasePrice');
  });

  it("masque le seuil d'alerte de stock aux employés", async () => {
    const p = await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 });
    await ctx.db.execute('UPDATE item SET stock_alert_threshold = 5 WHERE id = ?', [p.id]);
    expect((await getItem(ctx, boss, p.id)).stockAlertThreshold).toBe(5);
    expect((await getItem(ctx, paul, p.id)).stockAlertThreshold).toBeNull();
    expect((await listItems(ctx, paul))[0]?.stockAlertThreshold).toBeNull();
  });
});
