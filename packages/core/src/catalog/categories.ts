/**
 * Catégories de produits et de services, gérées par le boss. Elles servent à la saisie
 * rapide et aux statistiques. Une catégorie n'est jamais supprimée : on la désactive.
 */
import { audited, recordAudit, snapshot } from '../audit/audit';
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { setClause, toDb } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';
import { toCategory, type Category, type CategoryScope, type ItemType } from './types';

const SCOPES = ['PRODUCT', 'SERVICE', 'BOTH'] as const;

export async function findCategory(tx: SqlExecutor, companyId: string, categoryId: string): Promise<Category> {
  const { rows } = await tx.execute('SELECT * FROM category WHERE id = ? AND company_id = ?', [categoryId, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Catégorie introuvable.', { field: 'categoryId' });
  return toCategory(rows[0]);
}

/** Une catégorie « produits » ne peut pas contenir de service, et inversement. */
export function assertCategoryAccepts(category: Category, type: ItemType): void {
  if (category.appliesTo !== 'BOTH' && category.appliesTo !== type) {
    const label = type === 'PRODUCT' ? 'un produit' : 'un service';
    throw new DomainError('VALIDATION', `La catégorie « ${category.name} » ne peut pas contenir ${label}.`, { field: 'categoryId' });
  }
}

export async function createCategory(ctx: CoreContext, actor: Actor, input: { name: string; appliesTo: CategoryScope }): Promise<Category> {
  requireBoss(actor);
  requireBossDevice(ctx);
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO category (id, company_id, name, applies_to, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, actor.companyId, v.requiredText('name', input.name, 60), v.oneOf('appliesTo', input.appliesTo, SCOPES), await nextSeq(ctx, tx), now, now],
    );
    await recordAudit(ctx, tx, actor, { action: 'CATEGORY_CREATE', entityType: 'category', entityId: id, after: await snapshot(tx, 'category', id) });
  });
  return findCategory(ctx.db, actor.companyId, id);
}

/**
 * Renomme une catégorie, change sa portée ou la (dés)active. Restreindre la portée est refusé
 * si des articles de l'autre type y sont classés.
 */
export async function updateCategory(
  ctx: CoreContext,
  actor: Actor,
  categoryId: string,
  input: { name?: string; appliesTo?: CategoryScope; isActive?: boolean },
): Promise<Category> {
  requireBoss(actor);
  requireBossDevice(ctx);
  await ctx.db.transaction(async (tx) => {
    await findCategory(tx, actor.companyId, categoryId);
    const appliesTo = input.appliesTo !== undefined ? v.oneOf('appliesTo', input.appliesTo, SCOPES) : undefined;
    if (appliesTo && appliesTo !== 'BOTH') {
      const { rows } = await tx.execute('SELECT count(*) AS n FROM item WHERE category_id = ? AND type <> ?', [categoryId, appliesTo]);
      if (Number(rows[0]?.n) > 0) {
        throw new DomainError('CONFLICT', "Des articles de l'autre type sont classés dans cette catégorie.", { field: 'appliesTo' });
      }
    }
    const set = setClause({
      name: input.name !== undefined ? v.requiredText('name', input.name, 60) : undefined,
      applies_to: appliesTo,
      is_active: input.isActive !== undefined ? toDb(input.isActive) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: await nextSeq(ctx, tx),
    });
    await audited(ctx, tx, actor, { action: 'CATEGORY_UPDATE', entityType: 'category', entityId: categoryId }, () =>
      tx.execute(`UPDATE category SET ${set.sql} WHERE id = ?`, [...set.params, categoryId]),
    );
  });
  return findCategory(ctx.db, actor.companyId, categoryId);
}

/** Catégories, par nom. Les inactives sont exclues par défaut (saisie) ; le boss peut les inclure (gestion). */
export async function listCategories(ctx: CoreContext, actor: Actor, options: { includeInactive?: boolean } = {}): Promise<Category[]> {
  const { rows } = await ctx.db.execute(
    `SELECT * FROM category WHERE company_id = ? AND (? OR is_active = 1) ORDER BY name COLLATE NOCASE`,
    [actor.companyId, options.includeInactive ? 1 : 0],
  );
  return rows.map(toCategory);
}
