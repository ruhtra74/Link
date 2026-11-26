/**
 * Dépenses de l'entreprise (loyer, électricité, chaise cassée…). Voir docs/specs, section « Dépenses ».
 *
 * - Réservées au boss, saisies uniquement sur son téléphone, jamais envoyées aux employés (pas de seq).
 * - Rattachées à l'exercice ouvert au moment de la saisie ; leur date est informative.
 * - Modifiables et annulables (avec un motif) par le boss, sauf dans un exercice clos.
 * - Déduites dans le calcul du bénéfice.
 */
import { localDate, toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { assertFiscalYearWritable, getOpenFiscalYear, requireOpenFiscalYear } from '../fiscal-years/fiscal-years';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { num, setClause, str, strOrNull } from '../shared/sql';
import * as v from '../shared/validation';

export interface Expense {
  id: string;
  fiscalYearId: string;
  name: string;
  description: string | null;
  amount: number;
  /** Date de la dépense (AAAA-MM-JJ), informative. */
  expenseDate: string;
  status: 'ACTIVE' | 'CANCELLED';
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const toExpense = (r: Row): Expense => ({
  id: str(r, 'id'),
  fiscalYearId: str(r, 'fiscal_year_id'),
  name: str(r, 'name'),
  description: strOrNull(r, 'description'),
  amount: num(r, 'amount'),
  expenseDate: str(r, 'expense_date'),
  status: str(r, 'status') as Expense['status'],
  cancelReason: strOrNull(r, 'cancel_reason'),
  createdBy: str(r, 'created_by'),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

export interface ExpenseInput {
  name: string;
  description?: string | null;
  /** Montant en FCFA, entier, strictement positif. */
  amount: number;
  /** AAAA-MM-JJ ; par défaut, la date du jour sur le téléphone. */
  expenseDate?: string;
}

function requireExpenseManager(ctx: CoreContext, actor: Actor) {
  requireBoss(actor);
  requireBossDevice(ctx);
}

/** Date calendaire valide, pas dans le futur (par rapport au jour local). */
function validDate(ctx: CoreContext, value: string | undefined): string {
  const today = localDate(ctx.clock, ctx.clock.now());
  if (value === undefined) return today;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw new DomainError('VALIDATION', 'Date invalide (format AAAA-MM-JJ).', { field: 'expenseDate' });
  if (value > today) throw new DomainError('VALIDATION', 'Une dépense ne peut pas être datée dans le futur.', { field: 'expenseDate' });
  return value;
}

const positiveAmount = (value: number) => v.integerInRange('amount', value, 1, v.MAX_AMOUNT);

async function findExpenseRow(tx: SqlExecutor, companyId: string, id: string): Promise<Row> {
  const { rows } = await tx.execute('SELECT * FROM expense WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Dépense introuvable.');
  return rows[0];
}

async function assertModifiable(tx: SqlExecutor, row: Row) {
  if (row.status === 'CANCELLED') throw new DomainError('FORBIDDEN', 'Cette dépense est annulée : elle ne peut plus être modifiée.');
  await assertFiscalYearWritable(tx, str(row, 'fiscal_year_id'));
}

/** Enregistre une dépense dans l'exercice ouvert (sinon NO_OPEN_FISCAL_YEAR). */
export async function createExpense(ctx: CoreContext, actor: Actor, input: ExpenseInput): Promise<Expense> {
  requireExpenseManager(ctx, actor);
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    const year = await requireOpenFiscalYear(tx, actor.companyId);
    await tx.execute(
      `INSERT INTO expense (id, company_id, fiscal_year_id, name, description, amount, expense_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        actor.companyId,
        year.id,
        v.requiredText('name', input.name),
        v.optionalText('description', input.description, 500),
        positiveAmount(input.amount),
        validDate(ctx, input.expenseDate),
        actor.userId,
        now,
        now,
      ],
    );
  });
  return getExpense(ctx, actor, id);
}

/** Modifie une dépense (son exercice ne change pas). */
export async function updateExpense(ctx: CoreContext, actor: Actor, id: string, input: Partial<ExpenseInput>): Promise<Expense> {
  requireExpenseManager(ctx, actor);
  await ctx.db.transaction(async (tx) => {
    await assertModifiable(tx, await findExpenseRow(tx, actor.companyId, id));
    const set = setClause({
      name: input.name !== undefined ? v.requiredText('name', input.name) : undefined,
      description: input.description !== undefined ? v.optionalText('description', input.description, 500) : undefined,
      amount: input.amount !== undefined ? positiveAmount(input.amount) : undefined,
      expense_date: input.expenseDate !== undefined ? validDate(ctx, input.expenseDate) : undefined,
      updated_at: toIso(ctx.clock.now()),
    });
    await tx.execute(`UPDATE expense SET ${set.sql} WHERE id = ?`, [...set.params, id]);
  });
  return getExpense(ctx, actor, id);
}

/** Annule une dépense, avec un motif. Elle n'est jamais effacée et ne compte plus dans le bénéfice. */
export async function cancelExpense(ctx: CoreContext, actor: Actor, id: string, reason: string): Promise<Expense> {
  requireExpenseManager(ctx, actor);
  const motive = v.requiredText('reason', reason, 500);
  await ctx.db.transaction(async (tx) => {
    await assertModifiable(tx, await findExpenseRow(tx, actor.companyId, id));
    await tx.execute(`UPDATE expense SET status = 'CANCELLED', cancel_reason = ?, updated_at = ? WHERE id = ?`, [
      motive,
      toIso(ctx.clock.now()),
      id,
    ]);
  });
  return getExpense(ctx, actor, id);
}

export async function getExpense(ctx: CoreContext, actor: Actor, id: string): Promise<Expense> {
  requireBoss(actor);
  return toExpense(await findExpenseRow(ctx.db, actor.companyId, id));
}

export interface ExpenseList {
  expenses: Expense[];
  /** Total des dépenses actives de la liste. */
  total: number;
}

/**
 * Dépenses d'un exercice (par défaut l'exercice ouvert), les plus récentes d'abord.
 * Les annulées sont exclues sauf demande ; elles ne comptent jamais dans le total.
 */
export async function listExpenses(
  ctx: CoreContext,
  actor: Actor,
  options: { fiscalYearId?: string; includeCancelled?: boolean } = {},
): Promise<ExpenseList> {
  requireBoss(actor);
  const yearId = options.fiscalYearId ?? (await getOpenFiscalYear(ctx.db, actor.companyId))?.id;
  if (!yearId) return { expenses: [], total: 0 };
  const { rows } = await ctx.db.execute(
    `SELECT * FROM expense WHERE company_id = ? AND fiscal_year_id = ? AND (? OR status = 'ACTIVE')
     ORDER BY expense_date DESC, created_at DESC, id DESC`,
    [actor.companyId, yearId, options.includeCancelled ? 1 : 0],
  );
  const expenses = rows.map(toExpense);
  return { expenses, total: expenses.filter((e) => e.status === 'ACTIVE').reduce((s, e) => s + e.amount, 0) };
}
