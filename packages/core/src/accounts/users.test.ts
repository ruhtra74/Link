import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../context';
import { counterRandomBytes, createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, EMPLOYEE_TEMP_PASSWORD, pairDevice } from '../testing/fixtures';
import { authenticate } from './auth';
import {
  changePassword,
  createEmployee,
  generateTemporaryPassword,
  listUsers,
  resetEmployeePassword,
  setEmployeeActive,
  updateEmployee,
  updateOwnProfile,
} from './users';

let ctx: TestContext;
let boss: Actor;
beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
});

const asEmployee = (userId: string, deviceId = 'x'): Actor => ({ userId, companyId: boss.companyId, role: 'EMPLOYEE', deviceId });

describe('comptes employés', () => {
  it('crée un employé avec un mot de passe provisoire à changer', async () => {
    const paul = await addEmployee(ctx, boss);
    expect(paul).toMatchObject({ role: 'EMPLOYEE', login: 'paul', mustChangePassword: true, isActive: true });
  });

  it("refuse un identifiant déjà pris, sans tenir compte des majuscules", async () => {
    await addEmployee(ctx, boss, 'paul');
    await expect(addEmployee(ctx, boss, 'PAUL')).rejects.toMatchObject({ code: 'CONFLICT', details: { field: 'login' } });
    await expect(addEmployee(ctx, boss, 'awa')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it("refuse la création d'un compte par un employé", async () => {
    const paul = await addEmployee(ctx, boss);
    await expect(
      createEmployee(ctx, asEmployee(paul.id), { firstName: 'A', lastName: 'B', login: 'zoe', temporaryPassword: 'abcdef' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('modifie un employé et contrôle le nouvel identifiant', async () => {
    const paul = await addEmployee(ctx, boss, 'paul');
    await addEmployee(ctx, boss, 'zoe');
    expect(await updateEmployee(ctx, boss, paul.id, { lastName: 'Essomba', login: 'Paul.E' })).toMatchObject({
      lastName: 'Essomba',
      login: 'paul.e',
      firstName: 'Paul',
    });
    await expect(updateEmployee(ctx, boss, paul.id, { login: 'zoe' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Garder son propre identifiant n'est pas un conflit.
    await expect(updateEmployee(ctx, boss, paul.id, { login: 'paul.e' })).resolves.toBeDefined();
  });

  it('ne gère pas le compte du boss par ces actions, et signale un compte inconnu', async () => {
    await expect(updateEmployee(ctx, boss, boss.userId, { lastName: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setEmployeeActive(ctx, boss, boss.userId, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateEmployee(ctx, boss, 'inconnu', { lastName: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('liste le boss en premier ; liste réservée au boss', async () => {
    const paul = await addEmployee(ctx, boss);
    expect((await listUsers(ctx, boss)).map((u) => u.login)).toEqual(['awa', 'paul']);
    await expect(listUsers(ctx, asEmployee(paul.id))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('désactivation', () => {
  it("désactive l'employé et révoque tous ses appareils, sans toucher aux autres", async () => {
    const paul = await addEmployee(ctx, boss, 'paul');
    const zoe = await addEmployee(ctx, boss, 'zoe');
    const paulPhone1 = await pairDevice(ctx, boss.companyId, paul.id);
    const paulPhone2 = await pairDevice(ctx, boss.companyId, paul.id);
    const zoePhone = await pairDevice(ctx, boss.companyId, zoe.id);

    expect(await setEmployeeActive(ctx, boss, paul.id, false)).toMatchObject({ isActive: false });

    const status = async (id: string) => (await ctx.db.execute('SELECT status, wipe_pending FROM device WHERE id = ?', [id])).rows[0];
    expect(await status(paulPhone1.device.id)).toEqual({ status: 'REVOKED', wipe_pending: 1 });
    expect(await status(paulPhone2.device.id)).toEqual({ status: 'REVOKED', wipe_pending: 1 });
    expect(await status(zoePhone.device.id)).toEqual({ status: 'ACTIVE', wipe_pending: 0 });
  });

  it('la réactivation ne restaure pas les appareils révoqués (il faut les appairer à nouveau)', async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    await setEmployeeActive(ctx, boss, paul.id, false);
    expect(await setEmployeeActive(ctx, boss, paul.id, true)).toMatchObject({ isActive: true });
    expect((await ctx.db.execute('SELECT status FROM device WHERE id = ?', [phone.device.id])).rows[0]?.status).toBe('REVOKED');
  });

  it("garde le compte et son historique : rien n'est supprimé", async () => {
    const paul = await addEmployee(ctx, boss);
    await setEmployeeActive(ctx, boss, paul.id, false);
    expect((await ctx.db.execute('SELECT count(*) AS n FROM user WHERE id = ?', [paul.id])).rows[0]?.n).toBe(1);
  });
});

describe('mots de passe', () => {
  it("réinitialisation par le boss : nouveau mot de passe provisoire, l'ancien ne marche plus", async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    await changePassword(ctx, asEmployee(paul.id), { currentPassword: EMPLOYEE_TEMP_PASSWORD, newPassword: 'nouveau-mdp' });

    expect(await resetEmployeePassword(ctx, boss, paul.id, 'reset123')).toMatchObject({ mustChangePassword: true });
    await expect(authenticate(phone, { login: 'paul', password: 'nouveau-mdp' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await authenticate(phone, { login: 'paul', password: 'reset123' })).mustChangePassword).toBe(true);
  });

  it('changement de mot de passe : lève l’obligation après un mot de passe provisoire', async () => {
    const paul = await addEmployee(ctx, boss);
    const updated = await changePassword(ctx, asEmployee(paul.id), { currentPassword: EMPLOYEE_TEMP_PASSWORD, newPassword: 'nouveau-mdp' });
    expect(updated.mustChangePassword).toBe(false);
  });

  it("exige le mot de passe actuel et un nouveau mot de passe différent et assez long", async () => {
    const paul = await addEmployee(ctx, boss);
    const me = asEmployee(paul.id);
    await expect(changePassword(ctx, me, { currentPassword: 'faux', newPassword: 'nouveau-mdp' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(changePassword(ctx, me, { currentPassword: EMPLOYEE_TEMP_PASSWORD, newPassword: EMPLOYEE_TEMP_PASSWORD })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(changePassword(ctx, me, { currentPassword: EMPLOYEE_TEMP_PASSWORD, newPassword: '123' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('génère des mots de passe provisoires lisibles et valides', () => {
    const random = counterRandomBytes();
    const a = generateTemporaryPassword(random);
    const b = generateTemporaryPassword(random);
    expect(a).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('profil personnel', () => {
  it('chacun modifie son propre profil', async () => {
    const paul = await addEmployee(ctx, boss);
    expect(await updateOwnProfile(ctx, asEmployee(paul.id), { language: 'en', phone: '+237 6 99 00 00 00' })).toMatchObject({
      language: 'en',
      phone: '+237 6 99 00 00 00',
      firstName: 'Paul',
    });
  });

  it("sur le téléphone d'un employé, garde le seq reçu du boss (c'est le boss qui le réattribuera)", async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    const seqBefore = (await ctx.db.execute('SELECT seq FROM user WHERE id = ?', [paul.id])).rows[0]?.seq;
    await updateOwnProfile(phone, asEmployee(paul.id, phone.device.id), { firstName: 'Paulin' });
    const after = (await ctx.db.execute('SELECT seq, first_name FROM user WHERE id = ?', [paul.id])).rows[0];
    expect(after).toEqual({ seq: seqBefore, first_name: 'Paulin' });
  });

  it('refuse une langue non prise en charge', async () => {
    await expect(updateOwnProfile(ctx, boss, { language: 'de' as 'fr' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
