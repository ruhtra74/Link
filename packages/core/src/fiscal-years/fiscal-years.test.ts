import { beforeEach, describe, expect, it } from 'vitest';

import { setEmployeeActive } from '../accounts/users';
import { toIso, type Actor } from '../context';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import {
  assertFiscalYearWritable,
  closeAndOpenFiscalYear,
  closeFiscalYear,
  getClosureCheck,
  getOpenFiscalYear,
  listFiscalYears,
  openFiscalYear,
  requireOpenFiscalYear,
  updateFiscalYear,
} from './fiscal-years';

let ctx: TestContext;
let boss: Actor;
beforeEach(async () => {
  ctx = await createTestContext();
  boss = (await bootstrapCompany(ctx)).actor;
});

const seqOf = async (id: string) => (await ctx.db.execute('SELECT seq FROM fiscal_year WHERE id = ?', [id])).rows[0]?.seq;

describe('sans exercice ouvert', () => {
  it("aucun exercice n'existe après la création de l'entreprise", async () => {
    expect(await getOpenFiscalYear(ctx.db, boss.companyId)).toBeNull();
  });

  it('bloque ventes, dépenses et synchro (garde-fou commun)', async () => {
    await expect(requireOpenFiscalYear(ctx.db, boss.companyId)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });
});

describe('ouverture', () => {
  it('le boss ouvre le premier exercice', async () => {
    const year = await openFiscalYear(ctx, boss, { name: 'Exercice 2026', description: 'Première année' });
    expect(year).toMatchObject({ name: 'Exercice 2026', description: 'Première année', status: 'OPEN', closedAt: null, openedAt: toIso(ctx.clock.now()) });
    expect(await requireOpenFiscalYear(ctx.db, boss.companyId)).toEqual(year);
    expect(await seqOf(year.id)).toBeGreaterThan(0);
  });

  it("refuse d'ouvrir un deuxième exercice tant que le premier est ouvert", async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    await expect(openFiscalYear(ctx, boss, { name: '2027' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('exige un nom', async () => {
    await expect(openFiscalYear(ctx, boss, { name: '  ' })).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'name' } });
  });

  it("est réservée au boss, sur son téléphone", async () => {
    const paul = await addEmployee(ctx, boss);
    const paulPhone = await pairDevice(ctx, boss.companyId, paul.id);
    await expect(openFiscalYear(ctx, { ...boss, role: 'EMPLOYEE', userId: paul.id }, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(openFiscalYear(paulPhone, boss, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('clôture', () => {
  it("clôture l'exercice ouvert : plus aucun exercice ouvert ensuite", async () => {
    const year = await openFiscalYear(ctx, boss, { name: '2026' });
    ctx.clock.advance(86_400_000);
    const closed = await closeFiscalYear(ctx, boss);
    expect(closed).toMatchObject({ id: year.id, status: 'CLOSED', closedAt: '2026-01-06T08:00:00.000Z', closedBy: boss.userId });
    await expect(requireOpenFiscalYear(ctx.db, boss.companyId)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });

  it("signale qu'il n'y a rien à clôturer", async () => {
    await expect(closeFiscalYear(ctx, boss)).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });

  it('propage la clôture aux employés (nouveau seq)', async () => {
    const year = await openFiscalYear(ctx, boss, { name: '2026' });
    const before = Number(await seqOf(year.id));
    await closeFiscalYear(ctx, boss);
    expect(Number(await seqOf(year.id))).toBeGreaterThan(before);
  });

  it("un exercice clos est en lecture seule : on ne peut plus le modifier", async () => {
    const year = await openFiscalYear(ctx, boss, { name: '2026' });
    await closeFiscalYear(ctx, boss);
    await expect(assertFiscalYearWritable(ctx.db, year.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateFiscalYear(ctx, boss, year.id, { name: 'Autre' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('« Clôturer et ouvrir un nouvel exercice »', () => {
  it('clôture et ouvre au même instant, sans trou entre les deux', async () => {
    const first = await openFiscalYear(ctx, boss, { name: '2026' });
    ctx.clock.set('2027-01-01T00:00:00.000Z');
    const { closed, opened } = await closeAndOpenFiscalYear(ctx, boss, { name: '2027', description: 'Deuxième année' });
    expect(closed).toMatchObject({ id: first.id, status: 'CLOSED', closedAt: '2027-01-01T00:00:00.000Z' });
    expect(opened).toMatchObject({ name: '2027', status: 'OPEN', openedAt: '2027-01-01T00:00:00.000Z' });
    expect((await getOpenFiscalYear(ctx.db, boss.companyId))?.id).toBe(opened.id);
  });

  it("ne clôture rien si le nouvel exercice est invalide", async () => {
    const first = await openFiscalYear(ctx, boss, { name: '2026' });
    await expect(closeAndOpenFiscalYear(ctx, boss, { name: '' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getOpenFiscalYear(ctx.db, boss.companyId))?.id).toBe(first.id);
  });

  it("signale qu'il n'y a pas d'exercice ouvert à clôturer", async () => {
    await expect(closeAndOpenFiscalYear(ctx, boss, { name: '2027' })).rejects.toMatchObject({ code: 'NO_OPEN_FISCAL_YEAR' });
  });
});

describe('consultation et modification', () => {
  it('liste les exercices, le plus récent en premier ; les employés y ont accès (rangement de leur historique)', async () => {
    await openFiscalYear(ctx, boss, { name: '2026' });
    ctx.clock.advance(1000);
    await closeAndOpenFiscalYear(ctx, boss, { name: '2027' });
    const paul = await addEmployee(ctx, boss);
    const asPaul: Actor = { ...boss, role: 'EMPLOYEE', userId: paul.id };
    expect((await listFiscalYears(ctx, asPaul)).map((y) => `${y.name}:${y.status}`)).toEqual(['2027:OPEN', '2026:CLOSED']);
  });

  it("renomme l'exercice ouvert et efface sa description", async () => {
    const year = await openFiscalYear(ctx, boss, { name: '2026', description: 'à effacer' });
    expect(await updateFiscalYear(ctx, boss, year.id, { name: 'Année 2026', description: null })).toMatchObject({
      name: 'Année 2026',
      description: null,
    });
    // Sans description fournie, elle est conservée.
    await updateFiscalYear(ctx, boss, year.id, { description: 'gardée' });
    expect(await updateFiscalYear(ctx, boss, year.id, { name: 'Année 2026 bis' })).toMatchObject({ description: 'gardée' });
  });

  it('signale un exercice inconnu', async () => {
    await expect(updateFiscalYear(ctx, boss, 'inconnu', { name: 'X' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(assertFiscalYearWritable(ctx.db, 'inconnu')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('vérification avant clôture', () => {
  it('donne la dernière synchro de chaque employé actif, les jamais synchronisés en premier', async () => {
    const paul = await addEmployee(ctx, boss, 'paul');
    const zoe = await addEmployee(ctx, boss, 'zoe');
    const ali = await addEmployee(ctx, boss, 'ali');
    const paulPhone1 = await pairDevice(ctx, boss.companyId, paul.id);
    const paulPhone2 = await pairDevice(ctx, boss.companyId, paul.id);
    await pairDevice(ctx, boss.companyId, zoe.id);
    await ctx.db.execute(`UPDATE device SET last_sync_at = '2026-01-03T10:00:00.000Z' WHERE id = ?`, [paulPhone1.device.id]);
    await ctx.db.execute(`UPDATE device SET last_sync_at = '2026-01-04T18:00:00.000Z' WHERE id = ?`, [paulPhone2.device.id]);
    // Un employé désactivé n'apparaît pas.
    await setEmployeeActive(ctx, boss, ali.id, false);

    expect(await getClosureCheck(ctx, boss)).toEqual([
      { userId: zoe.id, firstName: 'Zoe', lastName: 'Mbarga', lastSyncAt: null },
      { userId: paul.id, firstName: 'Paul', lastName: 'Mbarga', lastSyncAt: '2026-01-04T18:00:00.000Z' },
    ]);
  });

  it('est réservée au boss', async () => {
    await expect(getClosureCheck(ctx, { ...boss, role: 'EMPLOYEE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
