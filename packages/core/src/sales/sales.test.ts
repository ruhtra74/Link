import { beforeEach, describe, expect, it } from 'vitest';

import { setEmployeeActive } from '../accounts/users';
import { createCustomer } from '../catalog/customers';
import { createProduct, createService, setItemArchived, setPurchasePrice, updateItem } from '../catalog/items';
import { createPaymentMethod, updatePaymentMethod } from '../catalog/payment-methods';
import type { Actor } from '../context';
import { closeAndOpenFiscalYear, openFiscalYear } from '../fiscal-years/fiscal-years';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import { cancelSale, correctSale, createSale, finalizeSaleOnBoss, getSale, listSales } from './sales';

let ctx: TestContext; // téléphone du boss
let boss: Actor;
let paulPhone: TestContext; // téléphone de Paul (même base, pour simuler la synchro)
let paul: Actor;
let coupe: string; // service, 2000
let shampoing: string; // produit, 2500, prix d'achat 1500
let gel: string; // produit, 1000, sans prix d'achat
let especes: string;

beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paulPhone = await pairDevice(ctx, boss.companyId, employee.id);
  paul = { userId: employee.id, companyId: boss.companyId, role: 'EMPLOYEE', deviceId: paulPhone.device.id };
  coupe = (await createService(ctx, boss, { name: 'Coupe homme', referencePrice: 2000 })).id;
  shampoing = (await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500, purchasePrice: 1500 })).id;
  gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
  especes = (await createPaymentMethod(ctx, boss, { name: 'Espèces' })).id;
});

const openYear = (name = '2026') => openFiscalYear(ctx, boss, { name });
const seqOf = async (id: string) => Number((await ctx.db.execute('SELECT seq FROM sale WHERE id = ?', [id])).rows[0]?.seq ?? 0);
/** Simule la réception par le boss lors d'une synchro (phase 3 : même traitement). */
const receiveOnBoss = (saleId: string) => ctx.db.transaction((tx) => finalizeSaleOnBoss(ctx, tx, saleId));

describe('vente saisie par le boss', () => {
  it("exige un exercice ouvert", async () => {
    await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }] })).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });

  it("est rattachée à l'exercice ouvert, déjà synchronisée, avec le coût d'achat fixé", async () => {
    const year = await openYear();
    const sale = await createSale(ctx, boss, {
      lines: [
        { itemId: coupe, quantity: 1 },
        { itemId: shampoing, quantity: 2, unitPrice: 2200 },
        { itemId: gel, quantity: 1 },
      ],
      paymentMethodId: especes,
      note: 'cliente régulière',
    });
    expect(sale).toMatchObject({
      fiscalYearId: year.id,
      employeeId: boss.userId,
      enteredById: boss.userId,
      deviceId: ctx.device.id,
      syncedAt: '2026-01-05T08:00:00.000Z',
      occurredAt: '2026-01-05T08:00:00.000Z',
      referenceTotal: 8000,
      adjustment: 0,
      totalAmount: 7400,
      entryMode: 'MANUAL',
      status: 'ACTIVE',
      version: 1,
      paymentMethodId: especes,
      note: 'cliente régulière',
    });
    expect(sale.lines.map((l) => [l.itemName, l.quantity, l.unitPrice, l.priceGap, l.unitCost])).toEqual([
      ['Coupe homme', 1, 2000, 0, 0], // service : coût 0
      ['Shampoing', 2, 2200, -600, 1500], // prix d'achat en vigueur
      ['Gel', 1, 1000, 0, 0], // produit sans prix d'achat : coût 0
    ]);
    expect(await seqOf(sale.id)).toBeGreaterThan(0);
  });

  it('applique un ajustement global du total', async () => {
    await openYear();
    const sale = await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }, { itemId: shampoing, quantity: 1 }], totalAmount: 4000 });
    expect(sale).toMatchObject({ referenceTotal: 4500, adjustment: -500, totalAmount: 4000 });
  });

  it('garde les informations figées même si le catalogue ou le prix d’achat changent ensuite', async () => {
    await openYear();
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }] });
    await updateItem(ctx, boss, shampoing, { name: 'Shampoing bio', referencePrice: 3000 });
    await setPurchasePrice(ctx, boss, shampoing, 1800);
    expect((await getSale(ctx, boss, sale.id)).lines[0]).toMatchObject({ itemName: 'Shampoing', referencePrice: 2500, unitCost: 1500 });
  });

  describe("au nom d'un employé", () => {
    it('attribue la vente à l’employé et garde le boss comme auteur de la saisie', async () => {
      await openYear();
      const sale = await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], employeeId: paul.userId });
      expect(sale).toMatchObject({ employeeId: paul.userId, enteredById: boss.userId, deviceId: ctx.device.id });
      expect(sale.syncedAt).not.toBeNull(); // créée chez le boss : déjà synchronisée, seul le boss la modifie
    });

    it('refuse un employé inconnu ou désactivé ; le boss lui-même est accepté', async () => {
      await openYear();
      await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], employeeId: 'inconnu' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], employeeId: boss.userId })).resolves.toMatchObject({
        employeeId: boss.userId,
      });
      await setEmployeeActive(ctx, boss, paul.userId, false);
      await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], employeeId: paul.userId })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });
  });

  it('refuse un article archivé, un mode de paiement désactivé, un client inconnu', async () => {
    await openYear();
    await setItemArchived(ctx, boss, gel, true);
    await expect(createSale(ctx, boss, { lines: [{ itemId: gel, quantity: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await updatePaymentMethod(ctx, boss, especes, { isActive: false });
    await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], paymentMethodId: especes })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], customerId: 'inconnu' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await ctx.db.execute('SELECT count(*) AS n FROM sale')).rows[0]?.n).toBe(0);
  });

  it("refuse une session qui n'appartient pas à ce téléphone", async () => {
    await openYear();
    await expect(createSale(ctx, { ...boss, deviceId: 'autre' }, { lines: [{ itemId: coupe, quantity: 1 }] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe("vente saisie sur le téléphone d'un employé", () => {
  it("reste en attente : pas d'exercice, pas d'accusé, pas de coût, pas de seq — même sans exercice ouvert", async () => {
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 1 }] });
    expect(sale).toMatchObject({ fiscalYearId: null, syncedAt: null, employeeId: paul.userId, enteredById: paul.userId, deviceId: paulPhone.device.id });
    expect(sale.lines[0]?.unitCost).toBeNull();
    expect(await seqOf(sale.id)).toBe(0);
  });

  it("l'employé ne peut pas attribuer une vente à quelqu'un d'autre", async () => {
    await expect(createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }], employeeId: boss.userId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it("à la réception, le boss la rattache à l'exercice ouvert et fixe le coût avec le prix d'achat du moment", async () => {
    const year = await openYear();
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 2 }] });
    await setPurchasePrice(ctx, boss, shampoing, 1600); // le prix change avant la synchro
    ctx.clock.advance(3_600_000);
    await receiveOnBoss(sale.id);
    const received = await getSale(ctx, boss, sale.id);
    expect(received).toMatchObject({ fiscalYearId: year.id, syncedAt: '2026-01-05T09:00:00.000Z', occurredAt: '2026-01-05T08:00:00.000Z' });
    expect(received.lines[0]?.unitCost).toBe(1600);
    expect(await seqOf(sale.id)).toBeGreaterThan(0);
  });

  it("une vente faite avant une clôture mais reçue après rejoint le nouvel exercice", async () => {
    await openYear('2026');
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] });
    const { opened } = await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    await receiveOnBoss(sale.id);
    expect((await getSale(ctx, boss, sale.id)).fiscalYearId).toBe(opened.id);
  });

  it("la réception est refusée sans exercice ouvert", async () => {
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] });
    await expect(receiveOnBoss(sale.id)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });

  it("l'employé ne voit jamais le coût d'achat", async () => {
    await openYear();
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 1 }] });
    await receiveOnBoss(sale.id);
    expect((await getSale(ctx, paul, sale.id)).lines[0]?.unitCost).toBeNull();
    expect((await getSale(ctx, boss, sale.id)).lines[0]?.unitCost).toBe(1500);
  });
});

describe("corrections par l'employé", () => {
  it('corrige librement sa vente tant qu’elle est en attente (pas de motif)', async () => {
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] });
    const fixed = await correctSale(paulPhone, paul, sale.id, { lines: [{ itemId: coupe, quantity: 1, unitPrice: 1500 }], note: 'fidèle' });
    expect(fixed).toMatchObject({ totalAmount: 1500, note: 'fidèle', version: 2, syncedAt: null });
    expect(fixed.lines[0]?.priceGap).toBe(-500);
  });

  it('ne peut plus rien modifier ni annuler après réception par le boss', async () => {
    await openYear();
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] });
    await receiveOnBoss(sale.id);
    await expect(correctSale(paulPhone, paul, sale.id, { note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(cancelSale(paulPhone, paul, sale.id, 'erreur')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("ne peut pas toucher à la vente d'un autre (ni la voir)", async () => {
    await openYear();
    const bossSale = await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }] });
    await expect(correctSale(paulPhone, paul, bossSale.id, { note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getSale(ctx, paul, bossSale.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('corrections par le boss', () => {
  let saleId: string;
  beforeEach(async () => {
    await openYear();
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 2 }, { itemId: coupe, quantity: 1 }] });
    await receiveOnBoss(sale.id);
    saleId = sale.id;
  });

  it("exige un motif quand les articles ou les montants changent", async () => {
    await expect(correctSale(ctx, boss, saleId, { totalAmount: 6000 })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'reason' } });
    const fixed = await correctSale(ctx, boss, saleId, { totalAmount: 6000, reason: 'remise oubliée' });
    expect(fixed).toMatchObject({ referenceTotal: 7000, adjustment: -1000, totalAmount: 6000, version: 2 });
  });

  it('rattache un client après coup sans motif', async () => {
    const client = await createCustomer(ctx, boss, { name: 'Mme Ngo' });
    expect(await correctSale(ctx, boss, saleId, { customerId: client.id })).toMatchObject({ customerId: client.id, version: 2 });
  });

  it("remplace les lignes : figé et coût d'origine conservés pour les articles déjà présents, catalogue actuel pour les nouveaux", async () => {
    await updateItem(ctx, boss, shampoing, { referencePrice: 3000 });
    await setPurchasePrice(ctx, boss, shampoing, 1800);
    await setPurchasePrice(ctx, boss, gel, 400);
    const fixed = await correctSale(ctx, boss, saleId, {
      lines: [
        { itemId: shampoing, quantity: 1 },
        { itemId: gel, quantity: 3 },
      ],
      reason: 'le client a rendu un shampoing et pris du gel',
    });
    expect(fixed.lines.map((l) => [l.itemName, l.quantity, l.referencePrice, l.unitCost])).toEqual([
      ['Shampoing', 1, 2500, 1500],
      ['Gel', 3, 1000, 400],
    ]);
    expect(fixed).toMatchObject({ totalAmount: 5500, adjustment: 0 });
  });

  it("garde la vente synchronisée et lui donne un nouveau seq (renvoi à l'employé en mode conservation)", async () => {
    const before = await seqOf(saleId);
    const fixed = await correctSale(ctx, boss, saleId, { note: 'vérifiée' });
    expect(fixed.syncedAt).not.toBeNull();
    expect(await seqOf(saleId)).toBeGreaterThan(before);
  });

  it("refuse toute modification dans un exercice clos", async () => {
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    await expect(correctSale(ctx, boss, saleId, { note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(cancelSale(ctx, boss, saleId, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuse une correction vide', async () => {
    await expect(correctSale(ctx, boss, saleId, {})).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('annulation', () => {
  it('exige un motif, garde la vente et trace qui a annulé', async () => {
    await openYear();
    const sale = await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }] });
    await expect(cancelSale(ctx, boss, sale.id, '  ')).rejects.toMatchObject({ code: 'VALIDATION' });
    ctx.clock.advance(60_000);
    const cancelled = await cancelSale(ctx, boss, sale.id, 'double saisie');
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'double saisie',
      cancelledBy: boss.userId,
      cancelledAt: '2026-01-05T08:01:00.000Z',
      version: 2,
    });
    expect(cancelled.lines).toHaveLength(1);
  });

  it("une vente annulée ne se modifie plus et ne s'annule pas deux fois", async () => {
    await openYear();
    const sale = await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }] });
    await cancelSale(ctx, boss, sale.id, 'erreur');
    await expect(cancelSale(ctx, boss, sale.id, 'encore')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(correctSale(ctx, boss, sale.id, { note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("l'employé annule sa vente en attente", async () => {
    const sale = await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] });
    expect(await cancelSale(paulPhone, paul, sale.id, 'client parti')).toMatchObject({ status: 'CANCELLED', syncedAt: null });
  });
});

describe('historique', () => {
  beforeEach(async () => {
    await openYear();
    const client = await createCustomer(ctx, boss, { name: 'Mme Ngo' });
    await createSale(ctx, boss, { lines: [{ itemId: coupe, quantity: 1 }], customerId: client.id });
    ctx.clock.advance(60_000);
    paulPhone.clock.set('2026-01-05T08:02:00.000Z');
    await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 1 }] });
    ctx.clock.set('2026-01-06T10:00:00.000Z');
    const s = await createSale(ctx, boss, { lines: [{ itemId: gel, quantity: 1 }], employeeId: paul.userId });
    await cancelSale(ctx, boss, s.id, 'erreur');
  });

  it("le boss voit toute l'équipe, la plus récente d'abord", async () => {
    expect((await listSales(ctx, boss)).map((s) => s.lines[0]?.itemName)).toEqual(['Gel', 'Shampoing', 'Coupe homme']);
  });

  it('un employé ne voit que ses ventes (y compris celles saisies pour lui), sans coût', async () => {
    const mine = await listSales(ctx, paul);
    expect(mine.map((s) => s.lines[0]?.itemName)).toEqual(['Gel', 'Shampoing']);
    expect(mine.every((s) => s.lines.every((l) => l.unitCost === null))).toBe(true);
    // Le filtre employé du boss est ignoré pour un employé.
    expect(await listSales(ctx, paul, { employeeId: boss.userId })).toHaveLength(2);
  });

  it('filtre par employé, article, client, état, attente, période ; pagine', async () => {
    const names = async (f: Parameters<typeof listSales>[2]) => (await listSales(ctx, boss, f)).map((s) => s.lines[0]?.itemName);
    expect(await names({ employeeId: boss.userId })).toEqual(['Coupe homme']);
    expect(await names({ itemId: shampoing })).toEqual(['Shampoing']);
    const client = (await ctx.db.execute('SELECT id FROM customer')).rows[0]!.id as string;
    expect(await names({ customerId: client })).toEqual(['Coupe homme']);
    expect(await names({ status: 'CANCELLED' })).toEqual(['Gel']);
    expect(await names({ pendingOnly: true })).toEqual(['Shampoing']);
    expect(await names({ from: '2026-01-05T00:00:00.000Z', to: '2026-01-06T00:00:00.000Z' })).toEqual(['Shampoing', 'Coupe homme']);
    expect(await names({ limit: 1, offset: 1 })).toEqual(['Shampoing']);
  });
});
