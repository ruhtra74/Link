import { beforeEach, describe, expect, it } from 'vitest';

import { createTestContext, type TestContext } from '../testing/context';
import { bootstrapCompany } from '../testing/fixtures';
import { getCompany, setupCompany, updateCompany } from './company';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

const setupInput = {
  company: { name: 'Salon Awa' },
  boss: { firstName: 'Awa', lastName: 'Diallo', login: 'awa', password: 'motdepasse' },
  device: { platform: 'ANDROID' as const },
};

describe("création de l'entreprise (premier lancement)", () => {
  it("n'existe pas avant le premier lancement", async () => {
    expect(await getCompany(ctx)).toBeNull();
  });

  it("crée l'entreprise en FCFA, le compte boss et enregistre ce téléphone comme le sien", async () => {
    const { company, boss, actor } = await bootstrapCompany(ctx);
    expect(company).toMatchObject({ name: 'Salon Awa', currency: 'XOF', historyRetentionMode: 'KEEP', stockEnabled: false, backupCopyRetentionDays: 30 });
    expect(boss).toMatchObject({ role: 'BOSS', login: 'awa', mustChangePassword: false, isActive: true, companyId: company.id });
    expect(actor).toEqual({ userId: boss.id, companyId: company.id, role: 'BOSS', deviceId: ctx.device.id });
    const device = (await ctx.db.execute('SELECT user_id, status FROM device WHERE id = ?', [ctx.device.id])).rows[0];
    expect(device).toEqual({ user_id: boss.id, status: 'ACTIVE' });
  });

  it('ne crée pas d’exercice : le boss le crée lui-même', async () => {
    await bootstrapCompany(ctx);
    expect((await ctx.db.execute('SELECT count(*) AS n FROM fiscal_year')).rows[0]?.n).toBe(0);
  });

  it('met l’identifiant du boss en minuscules', async () => {
    const { boss } = await setupCompany(ctx, { ...setupInput, boss: { ...setupInput.boss, login: '  Awa.Diallo ' } });
    expect(boss.login).toBe('awa.diallo');
  });

  it('attribue un seq à chaque ligne créée (entreprise, boss, appareil)', async () => {
    await bootstrapCompany(ctx);
    const seqs = await Promise.all(
      ['company', 'user', 'device'].map(async (t) => (await ctx.db.execute(`SELECT seq FROM ${t}`)).rows[0]?.seq),
    );
    expect(seqs).toEqual([1, 2, 3]);
    expect((await ctx.db.execute('SELECT last_seq FROM sync_state')).rows[0]?.last_seq).toBe(3);
  });

  it('refuse une deuxième entreprise sur le même téléphone', async () => {
    await bootstrapCompany(ctx);
    await expect(bootstrapCompany(ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it("refuse la création sur le téléphone d'un employé", async () => {
    const employeePhone = await createTestContext({ isBoss: false });
    await expect(bootstrapCompany(employeePhone)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['nom vide', { company: { name: '  ' } }, 'name'],
    ['couleur invalide', { company: { name: 'X', primaryColor: 'rouge' } }, 'primaryColor'],
    ['mot de passe trop court', { boss: { ...setupInput.boss, password: '123' } }, 'password'],
    ['identifiant invalide', { boss: { ...setupInput.boss, login: 'a b' } }, 'login'],
  ])('valide les champs : %s', async (_, override, field) => {
    await expect(setupCompany(ctx, { ...setupInput, ...override })).rejects.toMatchObject({ code: 'VALIDATION', details: { field } });
    expect(await getCompany(ctx)).toBeNull();
  });
});

describe("paramètres de l'entreprise", () => {
  it('le boss modifie les réglages ; les champs non fournis ne changent pas', async () => {
    const { actor } = await bootstrapCompany(ctx);
    ctx.clock.advance(60_000);
    const updated = await updateCompany(ctx, actor, { historyRetentionMode: 'DISAPPEAR', stockEnabled: true, primaryColor: '#1f5fbf' });
    expect(updated).toMatchObject({
      name: 'Salon Awa',
      activityType: 'Coiffure',
      historyRetentionMode: 'DISAPPEAR',
      stockEnabled: true,
      primaryColor: '#1F5FBF',
      settingsUpdatedAt: '2026-01-05T08:01:00.000Z',
    });
  });

  it('attribue un nouveau seq pour propager le changement aux employés', async () => {
    const { actor } = await bootstrapCompany(ctx);
    await updateCompany(ctx, actor, { name: 'Salon Awa & Fils' });
    expect((await ctx.db.execute('SELECT seq FROM company')).rows[0]?.seq).toBe(4);
  });

  it('refuse les modifications par un employé', async () => {
    const { actor } = await bootstrapCompany(ctx);
    await expect(updateCompany(ctx, { ...actor, role: 'EMPLOYEE' }, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('borne la durée de la copie de secours entre 1 et 365 jours', async () => {
    const { actor } = await bootstrapCompany(ctx);
    await expect(updateCompany(ctx, actor, { backupCopyRetentionDays: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateCompany(ctx, actor, { backupCopyRetentionDays: 400 })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await updateCompany(ctx, actor, { backupCopyRetentionDays: 60 })).backupCopyRetentionDays).toBe(60);
  });
});
