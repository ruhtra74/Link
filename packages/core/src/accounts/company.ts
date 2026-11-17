/**
 * Entreprise : création au premier lancement (téléphone du boss) et paramètres.
 * Voir docs/specs, « Entreprise et comptes » et « Personnalisation et paramètres ».
 */
import { toIso, type Actor, type CoreContext } from '../context';
import { DomainError } from '../errors';
import { requireBoss } from '../shared/permissions';
import { setClause, toDb } from '../shared/sql';
import * as v from '../shared/validation';
import { ensureSyncState, nextSeq } from '../sync/seq';
import { toCompany, toUser, type Company, type HistoryRetentionMode, type Language, type Platform, type User } from './types';

export interface CompanyProfileInput {
  name: string;
  activityType?: string | null;
  phone?: string | null;
  address?: string | null;
  logo?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
}

export interface SetupCompanyInput {
  company: CompanyProfileInput;
  boss: { firstName: string; lastName: string; login: string; password: string; phone?: string | null; language?: Language };
  device: { platform: Platform; label?: string | null };
}

/**
 * Premier lancement sur le téléphone du boss : crée l'entreprise, le compte boss et
 * enregistre ce téléphone comme le sien (centre de l'entreprise). Une seule entreprise par installation.
 * Le premier exercice n'est pas créé ici : le boss le crée lui-même (étape guidée).
 */
export async function setupCompany(ctx: CoreContext, input: SetupCompanyInput): Promise<{ company: Company; boss: User; actor: Actor }> {
  if (!ctx.device.isBoss) throw new DomainError('FORBIDDEN', "L'entreprise se crée sur le téléphone du boss.");

  const name = v.requiredText('name', input.company.name);
  const firstName = v.requiredText('firstName', input.boss.firstName);
  const lastName = v.requiredText('lastName', input.boss.lastName);
  const login = v.login(input.boss.login);
  const language = v.oneOf('language', input.boss.language ?? 'fr', ['fr', 'en'] as const);
  const platform = v.oneOf('platform', input.device.platform, ['IOS', 'ANDROID'] as const);
  const passwordHash = await ctx.passwords.hash(v.password('password', input.boss.password));

  const now = toIso(ctx.clock.now());
  const companyId = ctx.ids.newId();
  const bossId = ctx.ids.newId();

  await ctx.db.transaction(async (tx) => {
    const existing = await tx.execute('SELECT id FROM company LIMIT 1');
    if (existing.rows.length > 0) throw new DomainError('CONFLICT', 'Une entreprise existe déjà sur ce téléphone.');

    await ensureSyncState(tx, ctx.device.id, ctx.clock.now());
    await tx.execute(
      `INSERT INTO company (id, name, logo, primary_color, secondary_color, activity_type, phone, address, seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        name,
        v.optionalText('logo', input.company.logo, 2000),
        v.color('primaryColor', input.company.primaryColor),
        v.color('secondaryColor', input.company.secondaryColor),
        v.optionalText('activityType', input.company.activityType),
        v.optionalText('phone', input.company.phone, 30),
        v.optionalText('address', input.company.address),
        await nextSeq(ctx, tx),
        now,
        now,
      ],
    );
    await tx.execute(
      `INSERT INTO user (id, company_id, login, password_hash, first_name, last_name, phone, language, role, must_change_password, seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BOSS', 0, ?, ?, ?)`,
      [bossId, companyId, login, passwordHash, firstName, lastName, v.optionalText('phone', input.boss.phone, 30), language, await nextSeq(ctx, tx), now, now],
    );
    await tx.execute(
      `INSERT INTO device (id, company_id, user_id, label, platform, paired_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ctx.device.id, companyId, bossId, v.optionalText('label', input.device.label), platform, now, await nextSeq(ctx, tx)],
    );
  });

  const company = (await getCompany(ctx))!;
  const boss = toUser((await ctx.db.execute('SELECT * FROM user WHERE id = ?', [bossId])).rows[0]!);
  return { company, boss, actor: { userId: bossId, companyId, role: 'BOSS', deviceId: ctx.device.id } };
}

/** L'entreprise de cette installation, ou `null` avant le premier lancement. */
export async function getCompany(ctx: Pick<CoreContext, 'db'>): Promise<Company | null> {
  const { rows } = await ctx.db.execute('SELECT * FROM company LIMIT 1');
  return rows[0] ? toCompany(rows[0]) : null;
}

export interface CompanySettingsInput extends Partial<CompanyProfileInput> {
  /** Les employés gardent-ils leur historique après synchronisation ? Réglage global. */
  historyRetentionMode?: HistoryRetentionMode;
  stockEnabled?: boolean;
  /** Durée de la copie de secours chez les employés, en jours (1 à 365). */
  backupCopyRetentionDays?: number;
}

/** Modifie l'apparence, les coordonnées et les réglages de l'entreprise (boss seulement). La devise ne change pas. */
export async function updateCompany(ctx: CoreContext, actor: Actor, input: CompanySettingsInput): Promise<Company> {
  requireBoss(actor);
  const has = (k: keyof CompanySettingsInput) => input[k] !== undefined;
  const now = toIso(ctx.clock.now());

  await ctx.db.transaction(async (tx) => {
    const set = setClause({
      name: has('name') ? v.requiredText('name', input.name) : undefined,
      logo: has('logo') ? v.optionalText('logo', input.logo, 2000) : undefined,
      primary_color: has('primaryColor') ? v.color('primaryColor', input.primaryColor) : undefined,
      secondary_color: has('secondaryColor') ? v.color('secondaryColor', input.secondaryColor) : undefined,
      activity_type: has('activityType') ? v.optionalText('activityType', input.activityType) : undefined,
      phone: has('phone') ? v.optionalText('phone', input.phone, 30) : undefined,
      address: has('address') ? v.optionalText('address', input.address) : undefined,
      history_retention_mode: has('historyRetentionMode')
        ? v.oneOf('historyRetentionMode', input.historyRetentionMode!, ['KEEP', 'DISAPPEAR'] as const)
        : undefined,
      stock_enabled: has('stockEnabled') ? toDb(input.stockEnabled!) : undefined,
      backup_copy_retention_days: has('backupCopyRetentionDays')
        ? v.integerInRange('backupCopyRetentionDays', input.backupCopyRetentionDays!, 1, 365)
        : undefined,
      settings_updated_at: now,
      updated_at: now,
      seq: await nextSeq(ctx, tx),
    });
    const { changes } = await tx.execute(`UPDATE company SET ${set.sql} WHERE id = ?`, [...set.params, actor.companyId]);
    if (changes === 0) throw new DomainError('NOT_FOUND', 'Entreprise introuvable.');
  });

  return (await getCompany(ctx))!;
}

