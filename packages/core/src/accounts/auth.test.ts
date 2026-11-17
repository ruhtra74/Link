import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../context';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, BOSS_PASSWORD, EMPLOYEE_TEMP_PASSWORD, pairDevice } from '../testing/fixtures';
import { authenticate } from './auth';
import { listDevices, revokeDevice } from './devices';
import { setEmployeeActive } from './users';

let ctx: TestContext;
let boss: Actor;
beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
});

describe('connexion', () => {
  it('le boss se connecte sur son téléphone (identifiant insensible aux majuscules)', async () => {
    ctx.clock.advance(5_000);
    const { actor, mustChangePassword } = await authenticate(ctx, { login: ' AWA ', password: BOSS_PASSWORD });
    expect(actor).toEqual(boss);
    expect(mustChangePassword).toBe(false);
    expect((await ctx.db.execute('SELECT last_login_at FROM device WHERE id = ?', [ctx.device.id])).rows[0]?.last_login_at).toBe(
      '2026-01-05T08:00:05.000Z',
    );
  });

  it('donne le même message pour un identifiant inconnu et un mauvais mot de passe', async () => {
    const unknown = authenticate(ctx, { login: 'inconnu', password: BOSS_PASSWORD });
    const wrong = authenticate(ctx, { login: 'awa', password: 'faux-mdp' });
    await expect(unknown).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Identifiant ou mot de passe incorrect.' });
    await expect(wrong).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Identifiant ou mot de passe incorrect.' });
  });

  it("l'employé se connecte sur son téléphone et doit changer son mot de passe provisoire", async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    const result = await authenticate(phone, { login: 'paul', password: EMPLOYEE_TEMP_PASSWORD });
    expect(result.actor).toEqual({ userId: paul.id, companyId: boss.companyId, role: 'EMPLOYEE', deviceId: phone.device.id });
    expect(result.mustChangePassword).toBe(true);
  });

  it("un employé ne peut pas se connecter sur le téléphone du boss", async () => {
    await addEmployee(ctx, boss);
    await expect(authenticate(ctx, { login: 'paul', password: EMPLOYEE_TEMP_PASSWORD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("le boss ne peut pas se connecter sur le téléphone d'un employé", async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    await expect(authenticate(phone, { login: 'awa', password: BOSS_PASSWORD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("un employé ne peut pas se connecter sur le téléphone d'un collègue", async () => {
    const paul = await addEmployee(ctx, boss, 'paul');
    await addEmployee(ctx, boss, 'zoe');
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.id);
    await expect(authenticate(paulPhone, { login: 'zoe', password: EMPLOYEE_TEMP_PASSWORD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuse un téléphone qui n’est relié à aucune entreprise', async () => {
    const fresh = await createTestContext({ isBoss: false });
    await expect(authenticate(fresh, { login: 'awa', password: BOSS_PASSWORD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuse la connexion sur un appareil révoqué ou pour un compte désactivé', async () => {
    const paul = await addEmployee(ctx, boss, 'paul');
    const zoe = await addEmployee(ctx, boss, 'zoe');
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.id);
    const zoePhone = await pairDevice(ctx, boss.companyId, zoe.id);

    await revokeDevice(ctx, boss, paulPhone.device.id);
    await expect(authenticate(paulPhone, { login: 'paul', password: EMPLOYEE_TEMP_PASSWORD })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Ce téléphone a été révoqué par le boss.',
    });

    await setEmployeeActive(ctx, boss, zoe.id, false);
    await expect(authenticate(zoePhone, { login: 'zoe', password: EMPLOYEE_TEMP_PASSWORD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('révocation des appareils', () => {
  it("révoque l'appareil d'un employé : effacement à la prochaine synchro", async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    ctx.clock.advance(1000);
    expect(await revokeDevice(ctx, boss, phone.device.id)).toMatchObject({
      status: 'REVOKED',
      wipePending: true,
      revokedAt: '2026-01-05T08:00:01.000Z',
    });
  });

  it('le téléphone du boss ne se révoque pas ; appareil inconnu signalé ; réservé au boss', async () => {
    const paul = await addEmployee(ctx, boss);
    const phone = await pairDevice(ctx, boss.companyId, paul.id);
    await expect(revokeDevice(ctx, boss, ctx.device.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(revokeDevice(ctx, boss, 'inconnu')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      revokeDevice(ctx, { ...boss, role: 'EMPLOYEE', userId: paul.id }, phone.device.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("liste les appareils de l'entreprise ou d'un seul compte", async () => {
    const paul = await addEmployee(ctx, boss);
    await pairDevice(ctx, boss.companyId, paul.id);
    expect(await listDevices(ctx, boss)).toHaveLength(2);
    expect((await listDevices(ctx, boss, paul.id)).map((d) => d.userId)).toEqual([paul.id]);
  });
});
