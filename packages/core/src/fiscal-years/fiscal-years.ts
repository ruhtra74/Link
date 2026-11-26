/**
 * Exercices. Voir docs/specs, section « Exercices ».
 *
 * - Créés et clôturés manuellement par le boss, sur son téléphone. Un seul ouvert à la fois.
 * - Rien n'est créé automatiquement : sans exercice ouvert, le boss ne peut enregistrer ni vente
 *   ni dépense, et son téléphone n'accepte aucune synchronisation.
 * - Une opération appartient à l'exercice ouvert chez le boss au moment où il la reçoit
 *   (ou la saisit) ; sa date ne compte pas.
 * - Un exercice clos est strictement en lecture seule et n'est jamais supprimé.
 */
import { audited, recordAudit, snapshot } from '../audit/audit';
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { str, strOrNull } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';

export interface FiscalYear {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

const toFiscalYear = (r: Row): FiscalYear => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  name: str(r, 'name'),
  description: strOrNull(r, 'description'),
  status: str(r, 'status') as FiscalYear['status'],
  openedAt: str(r, 'opened_at'),
  closedAt: strOrNull(r, 'closed_at'),
  closedBy: strOrNull(r, 'closed_by'),
});

export interface FiscalYearInput {
  name: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Lecture et garde-fous utilisés par les autres modules (ventes, dépenses, synchro)
// ---------------------------------------------------------------------------

export async function getOpenFiscalYear(db: SqlExecutor, companyId: string): Promise<FiscalYear | null> {
  const { rows } = await db.execute(`SELECT * FROM fiscal_year WHERE company_id = ? AND status = 'OPEN'`, [companyId]);
  return rows[0] ? toFiscalYear(rows[0]) : null;
}

/**
 * L'exercice ouvert, ou l'erreur NO_OPEN_FISCAL_YEAR. À appeler, dans la transaction,
 * avant d'enregistrer une vente ou une dépense chez le boss, et avant d'accepter une synchro.
 */
export async function requireOpenFiscalYear(tx: SqlExecutor, companyId: string): Promise<FiscalYear> {
  const year = await getOpenFiscalYear(tx, companyId);
  if (!year) {
    throw new DomainError('NO_OPEN_FISCAL_YEAR', "Aucun exercice n'est ouvert. Le boss doit en ouvrir un avant toute vente, dépense ou synchronisation.");
  }
  return year;
}

/** Refuse toute modification d'une opération rattachée à un exercice clos (lecture seule stricte). */
export async function assertFiscalYearWritable(tx: SqlExecutor, fiscalYearId: string): Promise<void> {
  const { rows } = await tx.execute('SELECT status FROM fiscal_year WHERE id = ?', [fiscalYearId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Exercice introuvable.');
  if (rows[0].status === 'CLOSED') throw new DomainError('FORBIDDEN', 'Cet exercice est clos : il est en lecture seule.');
}

/**
 * Tous les exercices, le plus récent d'abord. Accessible aux employés : ils reçoivent le nom et
 * l'état des exercices pour ranger leur propre historique (mode conservation).
 */
export async function listFiscalYears(ctx: CoreContext, actor: Actor): Promise<FiscalYear[]> {
  const { rows } = await ctx.db.execute(`SELECT * FROM fiscal_year WHERE company_id = ? ORDER BY opened_at DESC, id DESC`, [actor.companyId]);
  return rows.map(toFiscalYear);
}

// ---------------------------------------------------------------------------
// Commandes du boss
// ---------------------------------------------------------------------------

async function insertOpenYear(ctx: CoreContext, tx: SqlExecutor, actor: Actor, input: FiscalYearInput, now: string): Promise<string> {
  if (await getOpenFiscalYear(tx, actor.companyId)) {
    throw new DomainError('CONFLICT', 'Un exercice est déjà ouvert. Il faut le clôturer avant d’en ouvrir un autre.');
  }
  const id = ctx.ids.newId();
  await tx.execute(
    `INSERT INTO fiscal_year (id, company_id, name, description, status, opened_at, seq) VALUES (?, ?, ?, ?, 'OPEN', ?, ?)`,
    [id, actor.companyId, v.requiredText('name', input.name), v.optionalText('description', input.description, 500), now, await nextSeq(ctx, tx)],
  );
  await recordAudit(ctx, tx, actor, { action: 'YEAR_OPEN', entityType: 'fiscal_year', entityId: id, after: await snapshot(tx, 'fiscal_year', id) });
  return id;
}

async function closeOpenYear(ctx: CoreContext, tx: SqlExecutor, actor: Actor, now: string): Promise<string> {
  const open = await requireOpenFiscalYear(tx, actor.companyId);
  await audited(ctx, tx, actor, { action: 'YEAR_CLOSE', entityType: 'fiscal_year', entityId: open.id }, async () =>
    tx.execute(`UPDATE fiscal_year SET status = 'CLOSED', closed_at = ?, closed_by = ?, seq = ? WHERE id = ?`, [
      now,
      actor.userId,
      await nextSeq(ctx, tx),
      open.id,
    ]),
  );
  return open.id;
}

const getById = async (ctx: CoreContext, id: string) =>
  toFiscalYear((await ctx.db.execute('SELECT * FROM fiscal_year WHERE id = ?', [id])).rows[0]!);

function requireBossOnBossPhone(ctx: CoreContext, actor: Actor) {
  requireBoss(actor);
  requireBossDevice(ctx);
}

/** Ouvre un exercice. Refusé si un exercice est déjà ouvert. Sert notamment au premier exercice (étape guidée). */
export async function openFiscalYear(ctx: CoreContext, actor: Actor, input: FiscalYearInput): Promise<FiscalYear> {
  requireBossOnBossPhone(ctx, actor);
  const id = await ctx.db.transaction((tx) => insertOpenYear(ctx, tx, actor, input, toIso(ctx.clock.now())));
  return getById(ctx, id);
}

/**
 * Clôture l'exercice ouvert. Ensuite, et jusqu'à l'ouverture du suivant, le boss ne peut plus
 * vendre, saisir de dépense ni accepter de synchronisation.
 */
export async function closeFiscalYear(ctx: CoreContext, actor: Actor): Promise<FiscalYear> {
  requireBossOnBossPhone(ctx, actor);
  const id = await ctx.db.transaction((tx) => closeOpenYear(ctx, tx, actor, toIso(ctx.clock.now())));
  return getById(ctx, id);
}

/**
 * Action habituelle : « Clôturer et ouvrir un nouvel exercice », en une seule transaction.
 * Si le nouvel exercice est invalide, rien n'est clôturé.
 */
export async function closeAndOpenFiscalYear(
  ctx: CoreContext,
  actor: Actor,
  next: FiscalYearInput,
): Promise<{ closed: FiscalYear; opened: FiscalYear }> {
  requireBossOnBossPhone(ctx, actor);
  const now = toIso(ctx.clock.now());
  const [closedId, openedId] = await ctx.db.transaction(async (tx) => {
    const closed = await closeOpenYear(ctx, tx, actor, now);
    return [closed, await insertOpenYear(ctx, tx, actor, next, now)] as const;
  });
  return { closed: await getById(ctx, closedId), opened: await getById(ctx, openedId) };
}

/** Renomme ou décrit l'exercice ouvert. Un exercice clos ne se modifie plus. */
export async function updateFiscalYear(
  ctx: CoreContext,
  actor: Actor,
  fiscalYearId: string,
  input: Partial<FiscalYearInput>,
): Promise<FiscalYear> {
  requireBossOnBossPhone(ctx, actor);
  await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.execute('SELECT company_id FROM fiscal_year WHERE id = ?', [fiscalYearId]);
    if (!rows[0] || rows[0].company_id !== actor.companyId) throw new DomainError('NOT_FOUND', 'Exercice introuvable.');
    await assertFiscalYearWritable(tx, fiscalYearId);
    await audited(ctx, tx, actor, { action: 'YEAR_UPDATE', entityType: 'fiscal_year', entityId: fiscalYearId }, async () =>
      tx.execute(
        `UPDATE fiscal_year SET name = COALESCE(?, name), description = CASE WHEN ? THEN ? ELSE description END, seq = ? WHERE id = ?`,
        [
          input.name !== undefined ? v.requiredText('name', input.name) : null,
          input.description !== undefined ? 1 : 0,
          input.description !== undefined ? v.optionalText('description', input.description, 500) : null,
          await nextSeq(ctx, tx),
          fiscalYearId,
        ],
      ),
    );
  });
  return getById(ctx, fiscalYearId);
}

export interface ClosureCheckEntry {
  userId: string;
  firstName: string;
  lastName: string;
  /** Dernière synchronisation, tous appareils actifs confondus. `null` : jamais synchronisé. */
  lastSyncAt: string | null;
}

/**
 * Avant de clôturer : pour chaque employé actif, la date de sa dernière synchronisation.
 * L'application rappelle que les opérations pas encore reçues compteront dans le prochain exercice.
 * (Le boss ne peut pas savoir avec certitude ce qu'un téléphone hors ligne a en attente.)
 */
export async function getClosureCheck(ctx: CoreContext, actor: Actor): Promise<ClosureCheckEntry[]> {
  requireBoss(actor);
  const { rows } = await ctx.db.execute(
    `SELECT u.id, u.first_name, u.last_name, max(d.last_sync_at) AS last_sync_at
     FROM user u LEFT JOIN device d ON d.user_id = u.id AND d.status = 'ACTIVE'
     WHERE u.company_id = ? AND u.role = 'EMPLOYEE' AND u.is_active = 1
     GROUP BY u.id
     ORDER BY last_sync_at IS NOT NULL, last_sync_at, u.last_name`,
    [actor.companyId],
  );
  return rows.map((r) => ({
    userId: str(r, 'id'),
    firstName: str(r, 'first_name'),
    lastName: str(r, 'last_name'),
    lastSyncAt: strOrNull(r, 'last_sync_at'),
  }));
}
