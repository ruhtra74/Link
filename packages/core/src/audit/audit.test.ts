import { beforeEach, describe, expect, it } from 'vitest';

import { updateCompany } from '../accounts/company';
import { revokeDevice } from '../accounts/devices';
import { changePassword, resetEmployeePassword, setEmployeeActive, updateOwnProfile } from '../accounts/users';
import { createCategory } from '../catalog/categories';
import { createCustomer } from '../catalog/customers';
import { createProduct, setItemArchived, setPurchasePrice, updateItem } from '../catalog/items';
import { createPaymentMethod } from '../catalog/payment-methods';
import type { Actor } from '../context';
import { cancelExpense, createExpense } from '../expenses/expenses';
import { closeAndOpenFiscalYear, openFiscalYear } from '../fiscal-years/fiscal-years';
import { cancelSale, correctSale, createSale } from '../sales/sales';
import { enableStockTracking, recordStockEntry } from '../stock/stock';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, EMPLOYEE_TEMP_PASSWORD, pairDevice } from '../testing/fixtures';
import { listAuditLog } from './audit';

let ctx: TestContext;
let boss: Actor;
let paul: Actor;
let paulPhone: TestContext;
let shampoing: string;

beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paulPhone = await pairDevice(ctx, boss.companyId, employee.id);
  paul = { userId: employee.id, companyId: boss.companyId, role: 'EMPLOYEE', deviceId: paulPhone.device.id };
  shampoing = (await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500 })).id;
});

const actions = async () => (await listAuditLog(ctx, boss)).map((e) => e.action).reverse();

describe('ce qui est tracé', () => {
  it("chaque action du boss laisse une trace, dans l'ordre", async () => {
    expect(await actions()).toEqual(['COMPANY_SETUP', 'USER_CREATE', 'ITEM_CREATE']);
  });

  it("couvre entreprise, comptes, appareils, exercices, catalogue, ventes, stock et dépenses", async () => {
    await updateCompany(ctx, boss, { stockEnabled: true });
    await setEmployeeActive(ctx, boss, paul.userId, false); // révoque aussi l'appareil de Paul
    await setEmployeeActive(ctx, boss, paul.userId, true);
    await resetEmployeePassword(ctx, boss, paul.userId, 'reset123');
    await updateOwnProfile(ctx, boss, { language: 'en' });
    await openFiscalYear(ctx, boss, { name: '2026' });
    const cat = await createCategory(ctx, boss, { name: 'Produits', appliesTo: 'PRODUCT' });
    await updateItem(ctx, boss, shampoing, { categoryId: cat.id });
    await setPurchasePrice(ctx, boss, shampoing, 1500);
    await createPaymentMethod(ctx, boss, { name: 'Espèces' });
    await createCustomer(ctx, boss, { name: 'Mme Ngo' });
    await enableStockTracking(ctx, boss, shampoing, { initialQuantity: 10 });
    await recordStockEntry(ctx, boss, shampoing, { quantity: 5, reason: 'livraison' });
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }] });
    await correctSale(ctx, boss, sale.id, { totalAmount: 2000, reason: 'remise' });
    await cancelSale(ctx, boss, sale.id, 'erreur');
    const expense = await createExpense(ctx, boss, { name: 'Loyer', amount: 50_000 });
    await cancelExpense(ctx, boss, expense.id, 'doublon');
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });

    expect((await actions()).slice(3)).toEqual([
      'COMPANY_UPDATE',
      'USER_DEACTIVATE',
      'DEVICE_REVOKE',
      'USER_REACTIVATE',
      'USER_PASSWORD_RESET',
      'PROFILE_UPDATE',
      'YEAR_OPEN',
      'CATEGORY_CREATE',
      'ITEM_UPDATE',
      'ITEM_COST_UPDATE',
      'PAYMENT_METHOD_CREATE',
      'CUSTOMER_CREATE',
      'STOCK_TRACKING_ENABLE',
      'STOCK_INVENTORY',
      'STOCK_ENTRY',
      'SALE_CREATE',
      'SALE_EDIT',
      'SALE_CANCEL',
      'EXPENSE_CREATE',
      'EXPENSE_CANCEL',
      'YEAR_CLOSE',
      'YEAR_OPEN',
    ]);
  });

  it("distingue l'auteur de la saisie et l'employé concerné", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }], employeeId: paul.userId });
    const [entry] = await listAuditLog(ctx, boss, { entityId: sale.id });
    expect(entry).toMatchObject({ action: 'SALE_CREATE', actorId: boss.userId, onBehalfOfId: paul.userId, deviceId: ctx.device.id });
    expect(entry?.after?.lines).toHaveLength(1);
  });

  it("garde l'état avant / après et le motif d'une correction", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 2 }] });
    await correctSale(ctx, boss, sale.id, { lines: [{ itemId: shampoing, quantity: 1 }], reason: 'le client en a rendu un' });
    const [edit] = await listAuditLog(ctx, boss, { entityId: sale.id, action: 'SALE_EDIT' });
    expect(edit).toMatchObject({ reason: 'le client en a rendu un', onBehalfOfId: null });
    expect(edit?.before).toMatchObject({ total_amount: 5000, version: 1 });
    expect(edit?.after).toMatchObject({ total_amount: 2500, version: 2 });
    expect((edit?.before?.lines as { quantity: number }[])[0]?.quantity).toBe(2);
    expect((edit?.after?.lines as { quantity: number }[])[0]?.quantity).toBe(1);
  });

  it("archivage, motif d'annulation de dépense, mouvement de stock avec motif", async () => {
    await updateCompany(ctx, boss, { stockEnabled: true });
    await openFiscalYear(ctx, boss, { name: '2026' });
    await setItemArchived(ctx, boss, shampoing, true);
    const e = await createExpense(ctx, boss, { name: 'Loyer', amount: 1000 });
    await cancelExpense(ctx, boss, e.id, 'doublon');
    const [cancel] = await listAuditLog(ctx, boss, { action: 'EXPENSE_CANCEL' });
    expect(cancel).toMatchObject({ reason: 'doublon', before: { status: 'ACTIVE' }, after: { status: 'CANCELLED' } });
    expect((await listAuditLog(ctx, boss, { action: 'ITEM_ARCHIVE' }))[0]?.after).toMatchObject({ is_archived: 1 });
  });
});

describe('garde-fous', () => {
  it("n'enregistre jamais de mot de passe ni d'empreinte", async () => {
    await resetEmployeePassword(ctx, boss, paul.userId, 'secret-reset');
    await changePassword(paulPhone, paul, { currentPassword: 'secret-reset', newPassword: 'secret-nouveau' });
    await changePassword(ctx, boss, { currentPassword: 'motdepasse-boss', newPassword: 'secret-boss' });
    const { rows } = await ctx.db.execute('SELECT * FROM audit_log');
    const dump = JSON.stringify(rows);
    for (const secret of ['password_hash', 'fake:', 'secret-reset', 'secret-nouveau', 'secret-boss', EMPLOYEE_TEMP_PASSWORD]) {
      expect(dump).not.toContain(secret);
    }
    expect(await actions()).toContain('PASSWORD_CHANGE');
  });

  it("une action qui échoue ne laisse aucune trace", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }] });
    const before = (await listAuditLog(ctx, boss)).length;
    await expect(correctSale(ctx, boss, sale.id, { totalAmount: 1000 })).rejects.toMatchObject({ code: 'VALIDATION' }); // motif manquant
    await expect(createSale(ctx, boss, { lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await listAuditLog(ctx, boss)).length).toBe(before);
  });

  it("rien n'est journalisé sur le téléphone d'un employé (le journal appartient au boss)", async () => {
    const before = (await listAuditLog(ctx, boss)).length;
    await createSale(paulPhone, paul, { lines: [{ itemId: shampoing, quantity: 1 }] });
    await updateOwnProfile(paulPhone, paul, { language: 'en' });
    await createCustomer(paulPhone, paul, { name: 'Mme Ngo' });
    expect((await listAuditLog(ctx, boss)).length).toBe(before);
  });

  it("révocation d'appareil : l'employé concerné est noté", async () => {
    await revokeDevice(ctx, boss, paulPhone.device.id);
    expect((await listAuditLog(ctx, boss, { action: 'DEVICE_REVOKE' }))[0]).toMatchObject({ onBehalfOfId: paul.userId, entityId: paulPhone.device.id });
  });
});

describe('consultation', () => {
  it('le plus récent d’abord ; filtres par élément, personne, action, période ; pagination', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    ctx.clock.set('2026-01-06T10:00:00.000Z');
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }], employeeId: paul.userId });
    const all = await listAuditLog(ctx, boss);
    expect(all[0]?.action).toBe('SALE_CREATE');
    // Une personne : ce qu'elle a fait, ou ce qui la concerne.
    expect((await listAuditLog(ctx, boss, { userId: paul.userId })).map((e) => e.action)).toEqual(['SALE_CREATE', 'USER_CREATE']);
    expect((await listAuditLog(ctx, boss, { entityType: 'item' })).map((e) => e.action)).toEqual(['ITEM_CREATE']);
    expect((await listAuditLog(ctx, boss, { from: '2026-01-06T00:00:00.000Z' })).map((e) => e.action)).toEqual(['SALE_CREATE']);
    expect((await listAuditLog(ctx, boss, { to: '2026-01-06T00:00:00.000Z' })).length).toBe(all.length - 1);
    expect((await listAuditLog(ctx, boss, { limit: 1, offset: 1 }))[0]?.id).toBe(all[1]?.id);
  });

  it('est réservée au boss', async () => {
    await expect(listAuditLog(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
