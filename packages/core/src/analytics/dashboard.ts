/**
 * Indicateurs du tableau de bord du boss, et récapitulatif de l'employé.
 * Voir docs/specs, « Tableau de bord du boss » et « Récapitulatif de l'employé ».
 *
 * Périmètre : un exercice (l'exercice ouvert par défaut ; un exercice clos reste consultable),
 * éventuellement restreint à une période. Seules les ventes actives comptent.
 *
 * - Chiffre d'affaires = total encaissé = produits + services + ajustements globaux
 *   (l'ajustement porte sur la vente entière, pas sur une ligne).
 * - Coût des articles vendus = coût d'achat unitaire fixé à la réception × quantité.
 * - Bénéfice indicatif = chiffre d'affaires − coût des articles vendus − dépenses (sans valeur comptable).
 */
import type { Actor, CoreContext } from '../context';
import type { SqlValue } from '../db/types';
import { DomainError } from '../errors';
import { getOpenFiscalYear } from '../fiscal-years/fiscal-years';
import { requireBoss } from '../shared/permissions';
import { num, str, strOrNull } from '../shared/sql';
import { previousPeriod, resolvePeriod, type PeriodInput, type ResolvedPeriod } from './periods';

export interface DashboardScope {
  /** Par défaut : l'exercice ouvert. */
  fiscalYearId?: string;
  /** Sans période : tout l'exercice. */
  period?: PeriodInput;
}

interface ResolvedScope {
  fiscalYearId: string;
  period: ResolvedPeriod | null;
}

async function resolveScope(ctx: CoreContext, actor: Actor, scope: DashboardScope): Promise<ResolvedScope> {
  requireBoss(actor);
  let fiscalYearId = scope.fiscalYearId;
  if (fiscalYearId) {
    const { rows } = await ctx.db.execute('SELECT id FROM fiscal_year WHERE id = ? AND company_id = ?', [fiscalYearId, actor.companyId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'Exercice introuvable.');
  } else {
    fiscalYearId = (await getOpenFiscalYear(ctx.db, actor.companyId))?.id;
    if (!fiscalYearId) throw new DomainError('NO_OPEN_FISCAL_YEAR', "Aucun exercice n'est ouvert.");
  }
  return { fiscalYearId, period: scope.period ? resolvePeriod(ctx.clock, scope.period) : null };
}

/** Condition SQL des ventes du périmètre (alias `s`). */
function salesWhere(actor: Actor, fiscalYearId: string, period: ResolvedPeriod | null): { sql: string; params: SqlValue[] } {
  const conditions = [`s.company_id = ?`, `s.fiscal_year_id = ?`, `s.status = 'ACTIVE'`];
  const params: SqlValue[] = [actor.companyId, fiscalYearId];
  if (period) {
    conditions.push('s.occurred_at >= ?', 's.occurred_at < ?');
    params.push(period.fromUtc, period.toUtc);
  }
  return { sql: conditions.join(' AND '), params };
}

const percent = (part: number, total: number) => (total === 0 ? 0 : Math.round((part / total) * 1000) / 10);

// ---------------------------------------------------------------------------
// Chiffre d'affaires, coût, dépenses, bénéfice
// ---------------------------------------------------------------------------

export interface RevenueFigures {
  salesCount: number;
  revenue: number;
  productsRevenue: number;
  servicesRevenue: number;
  /** Somme des ajustements globaux (négatif = remises sur le total). */
  adjustments: number;
  costOfGoodsSold: number;
}

async function revenueFigures(ctx: CoreContext, actor: Actor, fiscalYearId: string, period: ResolvedPeriod | null): Promise<RevenueFigures> {
  const where = salesWhere(actor, fiscalYearId, period);
  const { rows: totals } = await ctx.db.execute(
    `SELECT count(*) AS n, COALESCE(SUM(s.total_amount), 0) AS revenue, COALESCE(SUM(s.adjustment), 0) AS adjustments
     FROM sale s WHERE ${where.sql}`,
    where.params,
  );
  const { rows: lines } = await ctx.db.execute(
    `SELECT COALESCE(SUM(CASE WHEN l.item_type = 'PRODUCT' THEN l.line_total END), 0) AS products,
            COALESCE(SUM(CASE WHEN l.item_type = 'SERVICE' THEN l.line_total END), 0) AS services,
            COALESCE(SUM(COALESCE(l.unit_cost, 0) * l.quantity), 0) AS cogs
     FROM sale_line l JOIN sale s ON s.id = l.sale_id WHERE ${where.sql}`,
    where.params,
  );
  return {
    salesCount: num(totals[0]!, 'n'),
    revenue: num(totals[0]!, 'revenue'),
    adjustments: num(totals[0]!, 'adjustments'),
    productsRevenue: num(lines[0]!, 'products'),
    servicesRevenue: num(lines[0]!, 'services'),
    costOfGoodsSold: num(lines[0]!, 'cogs'),
  };
}

export interface RevenueSummary extends RevenueFigures {
  fiscalYearId: string;
  period: ResolvedPeriod | null;
  /** Dépenses actives de l'exercice, ou datées dans la période. */
  expenses: number;
  /** Bénéfice indicatif. */
  profit: number;
  /** Période précédente, dans le même exercice (seulement si une période est demandée). */
  previous: { period: ResolvedPeriod; salesCount: number; revenue: number; revenueChangePercent: number | null } | null;
}

/** Chiffre d'affaires, répartition produits/services, coût, dépenses et bénéfice indicatif. */
export async function getRevenueSummary(ctx: CoreContext, actor: Actor, scope: DashboardScope = {}): Promise<RevenueSummary> {
  const { fiscalYearId, period } = await resolveScope(ctx, actor, scope);
  const figures = await revenueFigures(ctx, actor, fiscalYearId, period);

  const expenseParams: SqlValue[] = [actor.companyId, fiscalYearId];
  let expenseFilter = '';
  if (period) {
    expenseFilter = 'AND expense_date >= ? AND expense_date <= ?';
    expenseParams.push(period.fromDate, period.toDate);
  }
  const { rows } = await ctx.db.execute(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expense WHERE company_id = ? AND fiscal_year_id = ? AND status = 'ACTIVE' ${expenseFilter}`,
    expenseParams,
  );
  const expenses = num(rows[0]!, 'total');

  let previous: RevenueSummary['previous'] = null;
  if (period && scope.period) {
    const prevPeriod = previousPeriod(ctx.clock, scope.period, period);
    const prev = await revenueFigures(ctx, actor, fiscalYearId, prevPeriod);
    previous = {
      period: prevPeriod,
      salesCount: prev.salesCount,
      revenue: prev.revenue,
      revenueChangePercent: prev.revenue === 0 ? null : percent(figures.revenue - prev.revenue, prev.revenue),
    };
  }

  return { fiscalYearId, period, ...figures, expenses, profit: figures.revenue - figures.costOfGoodsSold - expenses, previous };
}

// ---------------------------------------------------------------------------
// Activité des employés
// ---------------------------------------------------------------------------

export interface EmployeeActivity {
  userId: string;
  firstName: string;
  lastName: string;
  role: 'BOSS' | 'EMPLOYEE';
  salesCount: number;
  revenue: number;
  /** Part du chiffre d'affaires de l'entreprise, en pourcentage (une décimale). */
  sharePercent: number;
}

/**
 * Pour chaque producteur (le boss compte comme un producteur) : nombre de ventes, chiffre généré
 * et part du chiffre d'affaires. Les employés actifs sans vente apparaissent avec zéro ;
 * un employé désactivé apparaît s'il a vendu dans le périmètre.
 */
export async function getEmployeeActivity(ctx: CoreContext, actor: Actor, scope: DashboardScope = {}): Promise<EmployeeActivity[]> {
  const { fiscalYearId, period } = await resolveScope(ctx, actor, scope);
  const where = salesWhere(actor, fiscalYearId, period);
  const { rows } = await ctx.db.execute(
    `WITH per_user AS (
       SELECT s.employee_id, count(*) AS n, SUM(s.total_amount) AS revenue FROM sale s WHERE ${where.sql} GROUP BY s.employee_id
     )
     SELECT u.id, u.first_name, u.last_name, u.role, COALESCE(p.n, 0) AS n, COALESCE(p.revenue, 0) AS revenue
     FROM user u LEFT JOIN per_user p ON p.employee_id = u.id
     WHERE u.company_id = ? AND (u.role = 'BOSS' OR u.is_active = 1 OR p.n IS NOT NULL)
     ORDER BY revenue DESC, u.last_name, u.first_name`,
    [...where.params, actor.companyId],
  );
  const total = rows.reduce((s, r) => s + num(r, 'revenue'), 0);
  return rows.map((r) => ({
    userId: str(r, 'id'),
    firstName: str(r, 'first_name'),
    lastName: str(r, 'last_name'),
    role: str(r, 'role') as EmployeeActivity['role'],
    salesCount: num(r, 'n'),
    revenue: num(r, 'revenue'),
    sharePercent: percent(num(r, 'revenue'), total),
  }));
}

// ---------------------------------------------------------------------------
// Produits et services
// ---------------------------------------------------------------------------

export interface ItemSales {
  itemId: string;
  /** Nom actuel dans le catalogue. */
  name: string;
  type: 'PRODUCT' | 'SERVICE';
  categoryId: string | null;
  quantity: number;
  revenue: number;
}

export interface CategorySales {
  categoryId: string | null;
  /** « Sans catégorie » quand `categoryId` est vide. */
  name: string;
  quantity: number;
  revenue: number;
}

export interface ItemPerformance {
  /** Articles vendus, les plus vendus d'abord (quantité, puis chiffre). */
  sold: ItemSales[];
  /** Articles du catalogue (non archivés) sans aucune vente dans le périmètre. */
  notSold: { itemId: string; name: string; type: 'PRODUCT' | 'SERVICE' }[];
  byCategory: CategorySales[];
}

export async function getItemPerformance(ctx: CoreContext, actor: Actor, scope: DashboardScope = {}): Promise<ItemPerformance> {
  const { fiscalYearId, period } = await resolveScope(ctx, actor, scope);
  const where = salesWhere(actor, fiscalYearId, period);
  const { rows } = await ctx.db.execute(
    `SELECT i.id, i.name, i.type, i.category_id, SUM(l.quantity) AS quantity, SUM(l.line_total) AS revenue
     FROM sale_line l JOIN sale s ON s.id = l.sale_id JOIN item i ON i.id = l.item_id
     WHERE ${where.sql}
     GROUP BY i.id ORDER BY quantity DESC, revenue DESC, i.name COLLATE NOCASE`,
    where.params,
  );
  const sold: ItemSales[] = rows.map((r) => ({
    itemId: str(r, 'id'),
    name: str(r, 'name'),
    type: str(r, 'type') as ItemSales['type'],
    categoryId: strOrNull(r, 'category_id'),
    quantity: num(r, 'quantity'),
    revenue: num(r, 'revenue'),
  }));

  const soldIds = new Set(sold.map((s) => s.itemId));
  const { rows: catalog } = await ctx.db.execute(
    `SELECT id, name, type FROM item WHERE company_id = ? AND is_archived = 0 ORDER BY name COLLATE NOCASE`,
    [actor.companyId],
  );
  const notSold = catalog
    .filter((r) => !soldIds.has(str(r, 'id')))
    .map((r) => ({ itemId: str(r, 'id'), name: str(r, 'name'), type: str(r, 'type') as ItemSales['type'] }));

  const { rows: categories } = await ctx.db.execute('SELECT id, name FROM category WHERE company_id = ?', [actor.companyId]);
  const names = new Map(categories.map((c) => [str(c, 'id'), str(c, 'name')]));
  const byCat = new Map<string | null, CategorySales>();
  for (const s of sold) {
    const entry = byCat.get(s.categoryId) ?? { categoryId: s.categoryId, name: s.categoryId ? (names.get(s.categoryId) ?? '?') : 'Sans catégorie', quantity: 0, revenue: 0 };
    entry.quantity += s.quantity;
    entry.revenue += s.revenue;
    byCat.set(s.categoryId, entry);
  }
  return { sold, notSold, byCategory: [...byCat.values()].sort((a, b) => b.revenue - a.revenue) };
}

// ---------------------------------------------------------------------------
// Remises et prix négociés
// ---------------------------------------------------------------------------

export interface DiscountReport {
  /** Remises accordées sur les lignes (prix pratiqué inférieur à la référence), en positif. */
  lineDiscounts: number;
  /** Majorations sur les lignes (prix pratiqué supérieur à la référence). */
  lineMarkups: number;
  /** Remises accordées sur le total des ventes (ajustements globaux négatifs), en positif. */
  totalDiscounts: number;
  /** Remises par producteur : lignes + total. */
  byEmployee: { userId: string; firstName: string; lastName: string; discount: number }[];
  /** Remises par article (lignes seulement : l'ajustement global ne porte sur aucun article). */
  byItem: { itemId: string; name: string; discount: number }[];
}

export async function getDiscountReport(ctx: CoreContext, actor: Actor, scope: DashboardScope = {}): Promise<DiscountReport> {
  const { fiscalYearId, period } = await resolveScope(ctx, actor, scope);
  const where = salesWhere(actor, fiscalYearId, period);

  const { rows: lineTotals } = await ctx.db.execute(
    `SELECT COALESCE(SUM(CASE WHEN l.price_gap < 0 THEN -l.price_gap END), 0) AS discounts,
            COALESCE(SUM(CASE WHEN l.price_gap > 0 THEN l.price_gap END), 0) AS markups
     FROM sale_line l JOIN sale s ON s.id = l.sale_id WHERE ${where.sql}`,
    where.params,
  );
  const { rows: totalRows } = await ctx.db.execute(
    `SELECT COALESCE(SUM(CASE WHEN s.adjustment < 0 THEN -s.adjustment END), 0) AS discounts FROM sale s WHERE ${where.sql}`,
    where.params,
  );
  const { rows: perEmployee } = await ctx.db.execute(
    `WITH lines AS (
       SELECT s.employee_id, SUM(CASE WHEN l.price_gap < 0 THEN -l.price_gap ELSE 0 END) AS d
       FROM sale_line l JOIN sale s ON s.id = l.sale_id WHERE ${where.sql} GROUP BY s.employee_id
     ), totals AS (
       SELECT s.employee_id, SUM(CASE WHEN s.adjustment < 0 THEN -s.adjustment ELSE 0 END) AS d
       FROM sale s WHERE ${where.sql} GROUP BY s.employee_id
     )
     SELECT u.id, u.first_name, u.last_name, COALESCE(l.d, 0) + COALESCE(t.d, 0) AS discount
     FROM user u LEFT JOIN lines l ON l.employee_id = u.id LEFT JOIN totals t ON t.employee_id = u.id
     WHERE u.company_id = ? AND COALESCE(l.d, 0) + COALESCE(t.d, 0) > 0
     ORDER BY discount DESC, u.last_name`,
    [...where.params, ...where.params, actor.companyId],
  );
  const { rows: perItem } = await ctx.db.execute(
    `SELECT i.id, i.name, SUM(-l.price_gap) AS discount
     FROM sale_line l JOIN sale s ON s.id = l.sale_id JOIN item i ON i.id = l.item_id
     WHERE ${where.sql} AND l.price_gap < 0
     GROUP BY i.id ORDER BY discount DESC, i.name COLLATE NOCASE`,
    where.params,
  );

  return {
    lineDiscounts: num(lineTotals[0]!, 'discounts'),
    lineMarkups: num(lineTotals[0]!, 'markups'),
    totalDiscounts: num(totalRows[0]!, 'discounts'),
    byEmployee: perEmployee.map((r) => ({ userId: str(r, 'id'), firstName: str(r, 'first_name'), lastName: str(r, 'last_name'), discount: num(r, 'discount') })),
    byItem: perItem.map((r) => ({ itemId: str(r, 'id'), name: str(r, 'name'), discount: num(r, 'discount') })),
  };
}

// ---------------------------------------------------------------------------
// Récapitulatif personnel (employé ou boss)
// ---------------------------------------------------------------------------

export interface PeriodTotals {
  salesCount: number;
  total: number;
}

/**
 * Ventes du jour, de la semaine et du mois de la personne connectée, à partir des ventes présentes
 * sur ce téléphone : en attente, et déjà synchronisées si le mode conservation les garde.
 * En mode disparition, seules les ventes en attente y figurent (les autres ont été effacées).
 */
export async function getMySalesSummary(ctx: CoreContext, actor: Actor): Promise<{ today: PeriodTotals; week: PeriodTotals; month: PeriodTotals }> {
  const totals = async (preset: 'TODAY' | 'WEEK' | 'MONTH'): Promise<PeriodTotals> => {
    const p = resolvePeriod(ctx.clock, { preset });
    const { rows } = await ctx.db.execute(
      `SELECT count(*) AS n, COALESCE(SUM(total_amount), 0) AS total FROM sale
       WHERE company_id = ? AND employee_id = ? AND status = 'ACTIVE' AND occurred_at >= ? AND occurred_at < ?`,
      [actor.companyId, actor.userId, p.fromUtc, p.toUtc],
    );
    return { salesCount: num(rows[0]!, 'n'), total: num(rows[0]!, 'total') };
  };
  return { today: await totals('TODAY'), week: await totals('WEEK'), month: await totals('MONTH') };
}

