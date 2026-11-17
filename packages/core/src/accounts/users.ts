/**
 * Comptes : employés gérés par le boss, profil et mot de passe de chacun.
 * Voir docs/specs, « Entreprise et comptes ».
 */
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import type { RandomBytes } from '../ids';
import { requireBoss } from '../shared/permissions';
import { setClause } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';
import { revokeDevicesOfUser } from './devices';
import { toUser, type Language, type User } from './types';

async function findUser(tx: SqlExecutor, companyId: string, userId: string) {
  const { rows } = await tx.execute('SELECT * FROM user WHERE id = ? AND company_id = ?', [userId, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Compte introuvable.');
  return rows[0];
}

/** Le compte visé doit être un employé : le boss gère son propre compte par son profil. */
async function findEmployee(tx: SqlExecutor, companyId: string, userId: string) {
  const row = await findUser(tx, companyId, userId);
  if (row.role !== 'EMPLOYEE') throw new DomainError('FORBIDDEN', "Cette action ne s'applique qu'aux comptes employés.");
  return row;
}

async function assertLoginFree(tx: SqlExecutor, companyId: string, login: string, exceptUserId?: string) {
  const { rows } = await tx.execute('SELECT id FROM user WHERE company_id = ? AND login = ? AND id IS NOT ?', [companyId, login, exceptUserId ?? null]);
  if (rows.length > 0) throw new DomainError('CONFLICT', `L'identifiant « ${login} » est déjà utilisé.`, { field: 'login' });
}

/** Sur le téléphone d'un employé, `nextSeq` vaut null : on garde alors le seq reçu du boss. */
const seqOrKeep = async (ctx: CoreContext, tx: SqlExecutor) => (await nextSeq(ctx, tx)) ?? undefined;

const getUserById = async (ctx: CoreContext, userId: string): Promise<User> =>
  toUser((await ctx.db.execute('SELECT * FROM user WHERE id = ?', [userId])).rows[0]!);

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  login: string;
  /** Mot de passe provisoire, à changer par l'employé à sa première connexion. */
  temporaryPassword: string;
  phone?: string | null;
  language?: Language;
}

/** Crée un compte employé (boss seulement). Le compte ne dépend pas de l'exercice. */
export async function createEmployee(ctx: CoreContext, actor: Actor, input: EmployeeInput): Promise<User> {
  requireBoss(actor);
  const firstName = v.requiredText('firstName', input.firstName);
  const lastName = v.requiredText('lastName', input.lastName);
  const login = v.login(input.login);
  const language = v.oneOf('language', input.language ?? 'fr', ['fr', 'en'] as const);
  const passwordHash = await ctx.passwords.hash(v.password('temporaryPassword', input.temporaryPassword));
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());

  await ctx.db.transaction(async (tx) => {
    await assertLoginFree(tx, actor.companyId, login);
    await tx.execute(
      `INSERT INTO user (id, company_id, login, password_hash, first_name, last_name, phone, language, role, must_change_password, is_active, seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EMPLOYEE', 1, 1, ?, ?, ?)`,
      [id, actor.companyId, login, passwordHash, firstName, lastName, v.optionalText('phone', input.phone, 30), language, await nextSeq(ctx, tx), now, now],
    );
  });
  return getUserById(ctx, id);
}

export interface EmployeeUpdateInput {
  firstName?: string;
  lastName?: string;
  login?: string;
  phone?: string | null;
}

/** Modifie les informations d'un employé (boss seulement). */
export async function updateEmployee(ctx: CoreContext, actor: Actor, userId: string, input: EmployeeUpdateInput): Promise<User> {
  requireBoss(actor);
  await ctx.db.transaction(async (tx) => {
    await findEmployee(tx, actor.companyId, userId);
    const login = input.login !== undefined ? v.login(input.login) : undefined;
    if (login) await assertLoginFree(tx, actor.companyId, login, userId);
    const set = setClause({
      first_name: input.firstName !== undefined ? v.requiredText('firstName', input.firstName) : undefined,
      last_name: input.lastName !== undefined ? v.requiredText('lastName', input.lastName) : undefined,
      login,
      phone: input.phone !== undefined ? v.optionalText('phone', input.phone, 30) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: await seqOrKeep(ctx, tx),
    });
    await tx.execute(`UPDATE user SET ${set.sql} WHERE id = ?`, [...set.params, userId]);
  });
  return getUserById(ctx, userId);
}

/**
 * Désactive ou réactive un employé (boss seulement). Un compte n'est jamais supprimé.
 * La désactivation révoque tous ses appareils, qui s'effaceront à leur prochaine synchronisation.
 * La réactivation ne restaure pas ces appareils : il faudra les appairer à nouveau.
 */
export async function setEmployeeActive(ctx: CoreContext, actor: Actor, userId: string, active: boolean): Promise<User> {
  requireBoss(actor);
  await ctx.db.transaction(async (tx) => {
    await findEmployee(tx, actor.companyId, userId);
    await tx.execute(`UPDATE user SET is_active = ?, updated_at = ?, seq = ? WHERE id = ?`, [
      active ? 1 : 0,
      toIso(ctx.clock.now()),
      await nextSeq(ctx, tx),
      userId,
    ]);
    if (!active) await revokeDevicesOfUser(ctx, tx, userId);
  });
  return getUserById(ctx, userId);
}

/** Mot de passe oublié : le boss donne un nouveau mot de passe provisoire à l'employé. */
export async function resetEmployeePassword(ctx: CoreContext, actor: Actor, userId: string, temporaryPassword: string): Promise<User> {
  requireBoss(actor);
  const hash = await ctx.passwords.hash(v.password('temporaryPassword', temporaryPassword));
  await ctx.db.transaction(async (tx) => {
    await findEmployee(tx, actor.companyId, userId);
    await tx.execute(`UPDATE user SET password_hash = ?, must_change_password = 1, updated_at = ?, seq = ? WHERE id = ?`, [
      hash,
      toIso(ctx.clock.now()),
      await nextSeq(ctx, tx),
      userId,
    ]);
  });
  return getUserById(ctx, userId);
}

/** Tous les comptes de l'entreprise, boss compris (boss seulement). */
export async function listUsers(ctx: CoreContext, actor: Actor): Promise<User[]> {
  requireBoss(actor);
  const { rows } = await ctx.db.execute(
    `SELECT * FROM user WHERE company_id = ? ORDER BY role = 'EMPLOYEE', is_active DESC, last_name, first_name`,
    [actor.companyId],
  );
  return rows.map(toUser);
}

/** Le compte de la personne connectée. */
export async function getMe(ctx: CoreContext, actor: Actor): Promise<User> {
  return toUser(await findUser(ctx.db, actor.companyId, actor.userId));
}

export interface ProfileInput {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  photo?: string | null;
  language?: Language;
}

/** Chacun modifie son propre profil. Sur un téléphone d'employé, le changement partira au boss à la synchro. */
export async function updateOwnProfile(ctx: CoreContext, actor: Actor, input: ProfileInput): Promise<User> {
  await ctx.db.transaction(async (tx) => {
    await findUser(tx, actor.companyId, actor.userId);
    const set = setClause({
      first_name: input.firstName !== undefined ? v.requiredText('firstName', input.firstName) : undefined,
      last_name: input.lastName !== undefined ? v.requiredText('lastName', input.lastName) : undefined,
      phone: input.phone !== undefined ? v.optionalText('phone', input.phone, 30) : undefined,
      photo: input.photo !== undefined ? v.optionalText('photo', input.photo, 2000) : undefined,
      language: input.language !== undefined ? v.oneOf('language', input.language, ['fr', 'en'] as const) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: await seqOrKeep(ctx, tx),
    });
    await tx.execute(`UPDATE user SET ${set.sql} WHERE id = ?`, [...set.params, actor.userId]);
  });
  return getMe(ctx, actor);
}

/**
 * Chacun change son mot de passe, en donnant l'actuel. Lève l'obligation de changement
 * après un mot de passe provisoire (première connexion ou réinitialisation).
 */
export async function changePassword(
  ctx: CoreContext,
  actor: Actor,
  input: { currentPassword: string; newPassword: string },
): Promise<User> {
  const row = await findUser(ctx.db, actor.companyId, actor.userId);
  if (!(await ctx.passwords.verify(input.currentPassword, String(row.password_hash)))) {
    throw new DomainError('UNAUTHENTICATED', 'Mot de passe actuel incorrect.', { field: 'currentPassword' });
  }
  const next = v.password('newPassword', input.newPassword);
  if (next === input.currentPassword) {
    throw new DomainError('VALIDATION', "Le nouveau mot de passe doit être différent de l'actuel.", { field: 'newPassword' });
  }
  const hash = await ctx.passwords.hash(next);
  await ctx.db.transaction(async (tx) => {
    const set = setClause({ password_hash: hash, must_change_password: 0, updated_at: toIso(ctx.clock.now()), seq: await seqOrKeep(ctx, tx) });
    await tx.execute(`UPDATE user SET ${set.sql} WHERE id = ?`, [...set.params, actor.userId]);
  });
  return getMe(ctx, actor);
}

/**
 * Mot de passe provisoire de 8 caractères, majuscules et chiffres, sans caractères ambigus (0/O, 1/I).
 * L'alphabet compte 32 symboles : un octet modulo 32 reste parfaitement uniforme.
 */
export function generateTemporaryPassword(randomBytes: RandomBytes): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(8), (b) => alphabet[b % 32]).join('');
}
