import { beforeEach, describe, expect, it } from 'vitest';

import { updateCompany } from '../accounts/company';
import { createCustomer } from '../catalog/customers';
import { createProduct, createService, getItem, setItemArchived, updateItem } from '../catalog/items';
import { createPaymentMethod, updatePaymentMethod } from '../catalog/payment-methods';
import type { Actor } from '../context';
import { openFiscalYear } from '../fiscal-years/fiscal-years';
import { correctSale, createSale, finalizeSaleOnBoss, getSale } from '../sales/sales';
import { enableStockTracking } from '../stock/stock';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import {
  createBurstTemplate,
  deleteBurstTemplate,
  listBurstTemplates,
  recordBurstSale,
  undoLastBurstSale,
  updateBurstTemplate,
  UNDO_BURST_REASON,
} from './burst';

let ctx: TestContext; // téléphone du boss
let boss: Actor;
let paulPhone: TestContext;
let paul: Actor;
let coupe: string; // service 2000
let shampoing: string; // produit 2500
let especes: string;

beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paulPhone = await pairDevice(ctx, boss.companyId, employee.id);
  paul = { userId: employee.id, companyId: boss.companyId, role: 'EMPLOYEE', deviceId: paulPhone.device.id };
  coupe = (await createService(ctx, boss, { name: 'Coupe homme', referencePrice: 2000 })).id;
  shampoing = (await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500 })).id;
  especes = (await createPaymentMethod(ctx, boss, { name: 'Espèces' })).id;
});

/** Modèle « coupe + shampoing » (fonction : les articles n'existent qu'après beforeEach). */
const coupeShampoing = () => ({
  name: 'Coupe + shampoing',
  paymentMethodId: especes,
  lines: [
    { itemId: coupe, quantity: 1 },
    { itemId: shampoing, quantity: 1 },
  ],
});

describe('modèles de rafale', () => {
  it('chacun crée ses modèles ; le prix vide suit le catalogue', async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    expect(t).toMatchObject({ userId: paul.userId, name: 'Coupe + shampoing', paymentMethodId: especes });
    expect(t.lines.map((l) => [l.itemId, l.quantity, l.unitPrice])).toEqual([
      [coupe, 1, null],
      [shampoing, 1, null],
    ]);
  });

  it("ne montre à chacun que ses propres modèles", async () => {
    const mine = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    await createBurstTemplate(ctx, boss, { name: 'Boss', lines: [{ itemId: coupe, quantity: 1 }] });
    expect((await listBurstTemplates(paulPhone, paul)).map((t) => t.id)).toEqual([mine.id]);
    await expect(updateBurstTemplate(ctx, boss, mine.id, { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuse un modèle vide, un article archivé ou inconnu, un mode de paiement désactivé', async () => {
    await expect(createBurstTemplate(paulPhone, paul, { name: 'Vide', lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createBurstTemplate(paulPhone, paul, { name: 'X', lines: [{ itemId: 'inconnu', quantity: 1 }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await setItemArchived(ctx, boss, shampoing, true);
    await expect(createBurstTemplate(paulPhone, paul, coupeShampoing())).rejects.toMatchObject({ code: 'VALIDATION' });
    await setItemArchived(ctx, boss, shampoing, false);
    await updatePaymentMethod(ctx, boss, especes, { isActive: false });
    await expect(createBurstTemplate(paulPhone, paul, coupeShampoing())).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'paymentMethodId' } });
    expect(await listBurstTemplates(paulPhone, paul)).toEqual([]);
  });

  it('modifie (les lignes fournies remplacent les anciennes) et supprime un modèle', async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const updated = await updateBurstTemplate(paulPhone, paul, t.id, { name: 'Coupe seule', lines: [{ itemId: coupe, quantity: 1, unitPrice: 1500 }] });
    expect(updated).toMatchObject({ name: 'Coupe seule', paymentMethodId: especes });
    expect(updated.lines.map((l) => [l.itemId, l.unitPrice])).toEqual([[coupe, 1500]]);
    await deleteBurstTemplate(paulPhone, paul, t.id);
    expect(await listBurstTemplates(paulPhone, paul)).toEqual([]);
  });
});

describe('une vente par clic', () => {
  it('chaque clic crée une vente complète et indépendante, en mode rafale, à l’heure du clic', async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const first = await recordBurstSale(paulPhone, paul, t.id);
    ctx.clock.advance(90_000);
    const second = await recordBurstSale(paulPhone, paul, t.id);
    expect(first.id).not.toBe(second.id);
    for (const sale of [first, second]) {
      expect(sale).toMatchObject({ entryMode: 'BURST', totalAmount: 4500, paymentMethodId: especes, employeeId: paul.userId, customerId: null });
      expect(sale.lines.map((l) => l.itemName)).toEqual(['Coupe homme', 'Shampoing']);
    }
    expect(second.occurredAt).toBe('2026-01-05T08:01:30.000Z');
  });

  it('prix vide : prix actuel du catalogue au moment du clic ; prix fixé : celui du modèle', async () => {
    const t = await createBurstTemplate(paulPhone, paul, { name: 'X', lines: [{ itemId: coupe, quantity: 1 }, { itemId: shampoing, quantity: 2, unitPrice: 2000 }] });
    await updateItem(ctx, boss, coupe, { referencePrice: 2500 });
    const sale = await recordBurstSale(paulPhone, paul, t.id);
    expect(sale.lines.map((l) => [l.unitPrice, l.priceGap])).toEqual([
      [2500, 0],
      [2000, -1000],
    ]);
  });

  it('le client se désigne avant le clic, ou après coup', async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const ngo = await createCustomer(paulPhone, paul, { name: 'Mme Ngo' });
    expect((await recordBurstSale(paulPhone, paul, t.id, { customerId: ngo.id })).customerId).toBe(ngo.id);
    const anonymous = await recordBurstSale(paulPhone, paul, t.id);
    expect((await correctSale(paulPhone, paul, anonymous.id, { customerId: ngo.id })).customerId).toBe(ngo.id);
  });

  it("le boss l'utilise aussi, avec le champ « employé ayant fait la vente » ; exercice ouvert requis", async () => {
    const t = await createBurstTemplate(ctx, boss, coupeShampoing());
    await expect(recordBurstSale(ctx, boss, t.id)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
    await openFiscalYear(ctx, boss, { name: '2026' });
    const sale = await recordBurstSale(ctx, boss, t.id, { employeeId: paul.userId });
    expect(sale).toMatchObject({ entryMode: 'BURST', employeeId: paul.userId, enteredById: boss.userId });
    expect(sale.syncedAt).not.toBeNull();
  });

  it("un article archivé après la création du modèle bloque le clic", async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    await setItemArchived(ctx, boss, shampoing, true);
    await expect(recordBurstSale(paulPhone, paul, t.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('les ventes en rafale du boss sortent du stock comme les autres', async () => {
    await updateCompany(ctx, boss, { stockEnabled: true });
    await openFiscalYear(ctx, boss, { name: '2026' });
    await enableStockTracking(ctx, boss, shampoing, { initialQuantity: 10 });
    const t = await createBurstTemplate(ctx, boss, coupeShampoing());
    await recordBurstSale(ctx, boss, t.id);
    await recordBurstSale(ctx, boss, t.id);
    expect((await getItem(ctx, boss, shampoing)).stockQuantity).toBe(8);
  });
});

describe('« annuler la dernière vente »', () => {
  it('annule la vente en rafale la plus récente de cet utilisateur, avec un motif automatique', async () => {
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const first = await recordBurstSale(paulPhone, paul, t.id);
    const doubleClick = await recordBurstSale(paulPhone, paul, t.id); // même milliseconde : départagé par l'ordre d'enregistrement
    const undone = await undoLastBurstSale(paulPhone, paul);
    expect(undone).toMatchObject({ id: doubleClick.id, status: 'CANCELLED', cancelReason: UNDO_BURST_REASON });
    expect((await getSale(paulPhone, paul, first.id)).status).toBe('ACTIVE');
  });

  it('ne touche pas aux ventes saisies normalement ni à celles des autres', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const burst = await recordBurstSale(paulPhone, paul, t.id);
    ctx.clock.advance(1000);
    await createSale(paulPhone, paul, { lines: [{ itemId: coupe, quantity: 1 }] }); // vente normale, plus récente
    const bossTemplate = await createBurstTemplate(ctx, boss, coupeShampoing());
    await recordBurstSale(ctx, boss, bossTemplate.id); // vente en rafale du boss, plus récente
    expect((await undoLastBurstSale(paulPhone, paul)).id).toBe(burst.id);
  });

  it("signale qu'il n'y a rien à annuler", async () => {
    await expect(undoLastBurstSale(paulPhone, paul)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("un employé ne peut plus annuler une vente déjà reçue par le boss", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const t = await createBurstTemplate(paulPhone, paul, coupeShampoing());
    const sale = await recordBurstSale(paulPhone, paul, t.id);
    await ctx.db.transaction((tx) => finalizeSaleOnBoss(ctx, tx, sale.id));
    await expect(undoLastBurstSale(paulPhone, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
