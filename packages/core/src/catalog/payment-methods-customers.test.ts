import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../context';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import { createCustomer, searchCustomers, updateCustomer } from './customers';
import { createPaymentMethod, listPaymentMethods, updatePaymentMethod } from './payment-methods';

let ctx: TestContext;
let boss: Actor;
let paul: Actor;
beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
  const employee = await addEmployee(ctx, boss);
  paul = { ...boss, role: 'EMPLOYEE', userId: employee.id };
});

describe('modes de paiement', () => {
  it('le boss définit la liste ; tout le monde la consulte', async () => {
    await createPaymentMethod(ctx, boss, { name: 'Mobile money' });
    await createPaymentMethod(ctx, boss, { name: 'Espèces' });
    expect((await listPaymentMethods(ctx, paul)).map((m) => m.name)).toEqual(['Espèces', 'Mobile money']);
  });

  it('un mode désactivé disparaît de la saisie mais reste en gestion', async () => {
    const m = await createPaymentMethod(ctx, boss, { name: 'Chèque' });
    expect(await updatePaymentMethod(ctx, boss, m.id, { isActive: false })).toMatchObject({ isActive: false });
    expect(await listPaymentMethods(ctx, paul)).toEqual([]);
    expect(await listPaymentMethods(ctx, boss, { includeInactive: true })).toHaveLength(1);
  });

  it('est réservé au boss', async () => {
    await expect(createPaymentMethod(ctx, paul, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('clients', () => {
  it("un employé crée un client sur son téléphone : pas de seq (le boss l'attribuera à la réception)", async () => {
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.userId);
    const c = await createCustomer(paulPhone, { ...paul, deviceId: paulPhone.device.id }, { name: 'Mme Ngo', phone: '699 00 00 00' });
    expect(c).toMatchObject({ name: 'Mme Ngo', phone: '699 00 00 00', createdBy: paul.userId });
    expect((await ctx.db.execute('SELECT seq FROM customer WHERE id = ?', [c.id])).rows[0]?.seq).toBeNull();
  });

  it('le boss crée un client : seq attribué', async () => {
    const c = await createCustomer(ctx, boss, { name: 'M. Fotso' });
    expect(Number((await ctx.db.execute('SELECT seq FROM customer WHERE id = ?', [c.id])).rows[0]?.seq)).toBeGreaterThan(0);
  });

  it('exige un nom', async () => {
    await expect(createCustomer(ctx, paul, { name: ' ' })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'name' } });
  });

  it('recherche par nom ou téléphone', async () => {
    await createCustomer(ctx, boss, { name: 'Mme Ngo', phone: '699 11 22 33' });
    await createCustomer(ctx, boss, { name: 'M. Fotso', phone: '677 44 55 66' });
    expect((await searchCustomers(ctx, paul, 'ngo')).map((c) => c.name)).toEqual(['Mme Ngo']);
    expect((await searchCustomers(ctx, paul, '677')).map((c) => c.name)).toEqual(['M. Fotso']);
    expect(await searchCustomers(ctx, paul)).toHaveLength(2);
  });

  it('seul le boss corrige un client', async () => {
    const c = await createCustomer(ctx, paul, { name: 'Mme Ngo' });
    await expect(updateCustomer(ctx, paul, c.id, { name: 'Mme Ngo Bata' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await updateCustomer(ctx, boss, c.id, { name: 'Mme Ngo Bata', phone: null })).toMatchObject({ name: 'Mme Ngo Bata', phone: null });
  });
});
