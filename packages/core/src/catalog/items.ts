/**
 * Produits et services. Voir docs/specs, section « Catalogue et stock ».
 *
 * - Gérés par le boss, sur son téléphone. Un article n'est jamais supprimé : on l'archive
 *   (il disparaît de la saisie mais reste dans l'historique).
 * - Le type (produit ou service) ne change pas après création.
 * - Le prix d'achat (produits seulement, facultatif) est dans ITEM_COST, réservé au boss.
 * - Le suivi de stock s'active dans le module stock (il crée un premier comptage).
 */
import { audited, recordAudit, snapshot } from '../audit/audit';
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor, SqlValue } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { setClause, toDb } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';
import { assertCategoryAccepts, findCategory } from './categories';
import { toItem, type Item, type ItemType } from './types';

interface CommonItemInput {
  name: string;
  categoryId?: string | null;
  /** Prix de vente de référence en FCFA, pré-rempli à la saisie mais modifiable. */
  referencePrice: number;
  description?: string | null;
  photo?: string | null;
  isFavorite?: boolean;
}

export interface ProductInput extends CommonItemInput {
  internalRef?: string | null;
  /** Prix d'achat en FCFA, facultatif. Visible du boss seulement. */
  purchasePrice?: number | null;
}

export interface ServiceInput extends CommonItemInput {
  /** Durée indicative, en minutes. */
  durationMinutes?: number | null;
}

/** Masque ce qu'un employé ne doit pas voir. */
const forActor = (actor: Actor, item: Item): Item => (actor.role === 'BOSS' ? item : { ...item, stockAlertThreshold: null });

export async function findItem(tx: SqlExecutor, companyId: string, itemId: string): Promise<Item> {
  const { rows } = await tx.execute('SELECT * FROM item WHERE id = ? AND company_id = ?', [itemId, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Article introuvable.', { field: 'itemId' });
  return toItem(rows[0]);
}

async function validCategoryId(tx: SqlExecutor, companyId: string, categoryId: string | null | undefined, type: ItemType) {
  if (!categoryId) return null;
  assertCategoryAccepts(await findCategory(tx, companyId, categoryId), type);
  return categoryId;
}

const optionalDuration = (value: number | null | undefined) =>
  value == null ? null : v.integerInRange('durationMinutes', value, 1, 24 * 60);

async function insertItem(ctx: CoreContext, actor: Actor, type: ItemType, input: ProductInput & ServiceInput): Promise<Item> {
  requireBoss(actor);
  requireBossDevice(ctx);
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    const values: Record<string, SqlValue> = {
      id,
      company_id: actor.companyId,
      category_id: await validCategoryId(tx, actor.companyId, input.categoryId, type),
      type,
      name: v.requiredText('name', input.name),
      description: v.optionalText('description', input.description, 1000),
      photo: v.optionalText('photo', input.photo, 2000),
      reference_price: v.amount('referencePrice', input.referencePrice),
      internal_ref: type === 'PRODUCT' ? v.optionalText('internalRef', input.internalRef, 50) : null,
      duration_minutes: type === 'SERVICE' ? optionalDuration(input.durationMinutes) : null,
      is_favorite: toDb(input.isFavorite ?? false),
      seq: await nextSeq(ctx, tx),
      created_at: now,
      updated_at: now,
    };
    const cols = Object.keys(values);
    await tx.execute(`INSERT INTO item (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(values));
    if (type === 'PRODUCT' && input.purchasePrice != null) {
      await tx.execute('INSERT INTO item_cost (item_id, purchase_price, updated_at) VALUES (?, ?, ?)', [
        id,
        v.amount('purchasePrice', input.purchasePrice),
        now,
      ]);
    }
    await recordAudit(ctx, tx, actor, { action: 'ITEM_CREATE', entityType: 'item', entityId: id, after: await snapshot(tx, 'item', id) });
  });
  return findItem(ctx.db, actor.companyId, id);
}

export const createProduct = (ctx: CoreContext, actor: Actor, input: ProductInput) => insertItem(ctx, actor, 'PRODUCT', input);
export const createService = (ctx: CoreContext, actor: Actor, input: ServiceInput) => insertItem(ctx, actor, 'SERVICE', input);

export type ItemUpdateInput = Partial<Omit<ProductInput & ServiceInput, 'purchasePrice'>>;

/**
 * Modifie un article (boss). Le type ne change pas ; un champ propre à l'autre type est refusé.
 * Les ventes passées gardent les informations copiées au moment de la vente.
 */
export async function updateItem(ctx: CoreContext, actor: Actor, itemId: string, input: ItemUpdateInput): Promise<Item> {
  requireBoss(actor);
  requireBossDevice(ctx);
  await ctx.db.transaction(async (tx) => {
    const item = await findItem(tx, actor.companyId, itemId);
    if (item.type === 'SERVICE' && input.internalRef !== undefined) {
      throw new DomainError('VALIDATION', "Un service n'a pas de référence interne.", { field: 'internalRef' });
    }
    if (item.type === 'PRODUCT' && input.durationMinutes !== undefined) {
      throw new DomainError('VALIDATION', "Un produit n'a pas de durée.", { field: 'durationMinutes' });
    }
    const set = setClause({
      name: input.name !== undefined ? v.requiredText('name', input.name) : undefined,
      category_id: input.categoryId !== undefined ? await validCategoryId(tx, actor.companyId, input.categoryId, item.type) : undefined,
      reference_price: input.referencePrice !== undefined ? v.amount('referencePrice', input.referencePrice) : undefined,
      description: input.description !== undefined ? v.optionalText('description', input.description, 1000) : undefined,
      photo: input.photo !== undefined ? v.optionalText('photo', input.photo, 2000) : undefined,
      internal_ref: input.internalRef !== undefined ? v.optionalText('internalRef', input.internalRef, 50) : undefined,
      duration_minutes: input.durationMinutes !== undefined ? optionalDuration(input.durationMinutes) : undefined,
      is_favorite: input.isFavorite !== undefined ? toDb(input.isFavorite) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: await nextSeq(ctx, tx),
    });
    await audited(ctx, tx, actor, { action: 'ITEM_UPDATE', entityType: 'item', entityId: itemId }, () =>
      tx.execute(`UPDATE item SET ${set.sql} WHERE id = ?`, [...set.params, itemId]),
    );
  });
  return findItem(ctx.db, actor.companyId, itemId);
}

/** Archive (ou désarchive) un article : il disparaît de la saisie mais reste dans l'historique. */
export async function setItemArchived(ctx: CoreContext, actor: Actor, itemId: string, archived: boolean): Promise<Item> {
  requireBoss(actor);
  requireBossDevice(ctx);
  await ctx.db.transaction(async (tx) => {
    await findItem(tx, actor.companyId, itemId);
    await audited(ctx, tx, actor, { action: archived ? 'ITEM_ARCHIVE' : 'ITEM_UNARCHIVE', entityType: 'item', entityId: itemId }, async () =>
      tx.execute('UPDATE item SET is_archived = ?, updated_at = ?, seq = ? WHERE id = ?', [toDb(archived), toIso(ctx.clock.now()), await nextSeq(ctx, tx), itemId]),
    );
  });
  return findItem(ctx.db, actor.companyId, itemId);
}

export interface ItemFilter {
  type?: ItemType;
  categoryId?: string;
  favoritesOnly?: boolean;
  /** Recherche dans le nom et la référence interne. */
  search?: string;
  /** Inclure les articles archivés (gestion du catalogue). Par défaut : non (saisie). */
  includeArchived?: boolean;
}

/** Articles, favoris d'abord puis par nom. Accessible à tous ; masque les informations réservées au boss. */
export async function listItems(ctx: CoreContext, actor: Actor, filter: ItemFilter = {}): Promise<Item[]> {
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const { rows } = await ctx.db.execute(
    `SELECT * FROM item
     WHERE company_id = ?
       AND (? OR is_archived = 0)
       AND (? IS NULL OR type = ?)
       AND (? IS NULL OR category_id = ?)
       AND (? = 0 OR is_favorite = 1)
       AND (? IS NULL OR name LIKE ? OR internal_ref LIKE ?)
     ORDER BY is_favorite DESC, name COLLATE NOCASE`,
    [
      actor.companyId,
      filter.includeArchived ? 1 : 0,
      filter.type ?? null,
      filter.type ?? null,
      filter.categoryId ?? null,
      filter.categoryId ?? null,
      filter.favoritesOnly ? 1 : 0,
      search,
      search,
      search,
    ],
  );
  return rows.map((r) => forActor(actor, toItem(r)));
}

export async function getItem(ctx: CoreContext, actor: Actor, itemId: string): Promise<Item> {
  return forActor(actor, await findItem(ctx.db, actor.companyId, itemId));
}

// ---------------------------------------------------------------------------
// Prix d'achat (boss seulement, jamais envoyé aux employés)
// ---------------------------------------------------------------------------

/** Fixe ou efface le prix d'achat d'un produit. Un produit sans prix d'achat est compté pour un coût nul. */
export async function setPurchasePrice(ctx: CoreContext, actor: Actor, itemId: string, purchasePrice: number | null): Promise<void> {
  requireBoss(actor);
  requireBossDevice(ctx);
  await ctx.db.transaction(async (tx) => {
    const item = await findItem(tx, actor.companyId, itemId);
    if (item.type !== 'PRODUCT') throw new DomainError('VALIDATION', "Un service n'a pas de prix d'achat.", { field: 'purchasePrice' });
    const now = toIso(ctx.clock.now());
    await audited(ctx, tx, actor, { action: 'ITEM_COST_UPDATE', entityType: 'item_cost', entityId: itemId }, async () => {
      if (purchasePrice == null) {
        await tx.execute('DELETE FROM item_cost WHERE item_id = ?', [itemId]);
      } else {
        await tx.execute(
          `INSERT INTO item_cost (item_id, purchase_price, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (item_id) DO UPDATE SET purchase_price = excluded.purchase_price, updated_at = excluded.updated_at`,
          [itemId, v.amount('purchasePrice', purchasePrice), now],
        );
      }
    });
  });
}

/** Prix d'achat actuels, par identifiant d'article (produits qui en ont un). Boss seulement. */
export async function getPurchasePrices(ctx: CoreContext, actor: Actor): Promise<Record<string, number>> {
  requireBoss(actor);
  const { rows } = await ctx.db.execute(
    `SELECT c.item_id, c.purchase_price FROM item_cost c JOIN item i ON i.id = c.item_id
     WHERE i.company_id = ? AND c.purchase_price IS NOT NULL`,
    [actor.companyId],
  );
  return Object.fromEntries(rows.map((r) => [String(r.item_id), Number(r.purchase_price)]));
}
