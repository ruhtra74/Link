/**
 * Données de départ pour les tests. Non exporté par `@link/core`.
 */
import { setupCompany } from '../accounts/company';
import { createEmployee } from '../accounts/users';
import type { Actor } from '../context';
import { toIso } from '../context';
import type { TestContext } from './context';

export const BOSS_PASSWORD = 'motdepasse-boss';
export const EMPLOYEE_TEMP_PASSWORD = 'provisoire1';

/** Entreprise « Salon Awa » créée sur le téléphone du boss. */
export async function bootstrapCompany(ctx: TestContext) {
  return setupCompany(ctx, {
    company: { name: 'Salon Awa', activityType: 'Coiffure' },
    boss: { firstName: 'Awa', lastName: 'Diallo', login: 'awa', password: BOSS_PASSWORD },
    device: { platform: 'ANDROID', label: 'Téléphone du boss' },
  });
}

/** Employé dont le prénom est tiré de l'identifiant (paul → Paul), nom « Mbarga ». */
export async function addEmployee(ctx: TestContext, boss: Actor, login = 'paul') {
  const firstName = login.charAt(0).toUpperCase() + login.slice(1);
  return createEmployee(ctx, boss, { firstName, lastName: 'Mbarga', login, temporaryPassword: EMPLOYEE_TEMP_PASSWORD });
}

/**
 * Simule un appareil appairé à un employé, dans la même base (l'appairage réel arrive en phase 3).
 * Renvoie un contexte « téléphone de l'employé » qui partage la base du test.
 */
export async function pairDevice(ctx: TestContext, companyId: string, userId: string): Promise<TestContext> {
  const deviceId = ctx.ids.newId();
  await ctx.db.execute(`INSERT INTO device (id, company_id, user_id, platform, paired_at, seq) VALUES (?, ?, ?, 'ANDROID', ?, NULL)`, [
    deviceId,
    companyId,
    userId,
    toIso(ctx.clock.now()),
  ]);
  return { ...ctx, device: { id: deviceId, isBoss: false } };
}
