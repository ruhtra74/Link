/**
 * Mode rafale : enregistrer très vite de nombreuses ventes, par exemple quand un coiffeur enchaîne
 * les clients. Voir docs/specs, section « Mode rafale ».
 *
 * - Chaque utilisateur définit ses modèles sur son téléphone (tables locales, jamais synchronisées) :
 *   un ou plusieurs articles, leurs quantités, éventuellement un prix fixé, un mode de paiement.
 * - Chaque clic crée une vraie vente, indépendante, avec l'heure du clic. Le client est facultatif
 *   et se désigne avant le clic ou après coup (correction de la vente).
 * - « Annuler la dernière vente » évite les erreurs de double clic.
 */
import { findItem } from '../catalog/items';
import { findPaymentMethod } from '../catalog/payment-methods';
import { toIso, type Actor, type CoreContext } from '../context';
import type { Row, SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { MAX_QUANTITY } from '../sales/compute';
import { cancelSale, createSale } from '../sales/sales';
import type { Sale } from '../sales/types';
import { num, str, strOrNull } from '../shared/sql';
import * as v from '../shared/validation';

export interface BurstTemplateLine {
  id: string;
  itemId: string;
  quantity: number;
  /** `null` : prix de référence actuel du catalogue au moment du clic. */
  unitPrice: number | null;
}

export interface BurstTemplate {
  id: string;
  userId: string;
  name: string;
  paymentMethodId: string | null;
  lines: BurstTemplateLine[];
  createdAt: string;
  updatedAt: string;
}

export interface BurstTemplateInput {
  name: string;
  paymentMethodId?: string | null;
  lines: { itemId: string; quantity: number; unitPrice?: number | null }[];
}

export const UNDO_BURST_REASON = 'Annulation de la dernière vente en rafale';

const toLine = (r: Row): BurstTemplateLine => ({
  id: str(r, 'id'),
  itemId: str(r, 'item_id'),
  quantity: num(r, 'quantity'),
  unitPrice: r.unit_price == null ? null : num(r, 'unit_price'),
});

/** Les modèles d'un utilisateur ne sont visibles que par lui (sinon : introuvable). */
async function findTemplateRow(tx: SqlExecutor, actor: Actor, templateId: string): Promise<Row> {
  const { rows } = await tx.execute('SELECT * FROM burst_template WHERE id = ? AND user_id = ?', [templateId, actor.userId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Modèle de rafale introuvable.');
  return rows[0];
}

async function loadTemplate(db: SqlExecutor, row: Row): Promise<BurstTemplate> {
  const { rows } = await db.execute('SELECT * FROM burst_template_line WHERE template_id = ? ORDER BY rowid', [str(row, 'id')]);
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    name: str(row, 'name'),
    paymentMethodId: strOrNull(row, 'payment_method_id'),
    lines: rows.map(toLine),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

/** Vérifie et écrit les lignes du modèle (articles existants et non archivés). */
async function writeLines(ctx: CoreContext, tx: SqlExecutor, actor: Actor, templateId: string, lines: BurstTemplateInput['lines']) {
  if (!lines || lines.length === 0) throw new DomainError('VALIDATION', 'Un modèle contient au moins un article.', { field: 'lines' });
  for (const [i, line] of lines.entries()) {
    const item = await findItem(tx, actor.companyId, line.itemId);
    if (item.isArchived) throw new DomainError('VALIDATION', `« ${item.name} » est archivé.`, { field: `lines[${i}].itemId` });
    await tx.execute('INSERT INTO burst_template_line (id, template_id, item_id, quantity, unit_price) VALUES (?, ?, ?, ?, ?)', [
      ctx.ids.newId(),
      templateId,
      item.id,
      v.integerInRange(`lines[${i}].quantity`, line.quantity, 1, MAX_QUANTITY),
      line.unitPrice == null ? null : v.amount(`lines[${i}].unitPrice`, line.unitPrice),
    ]);
  }
}

async function validPaymentMethod(tx: SqlExecutor, actor: Actor, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const method = await findPaymentMethod(tx, actor.companyId, id);
  if (!method.isActive) throw new DomainError('VALIDATION', `Le mode de paiement « ${method.name} » n'est plus proposé.`, { field: 'paymentMethodId' });
  return method.id;
}

/** Crée un modèle de rafale (boss ou employé, pour lui-même). */
export async function createBurstTemplate(ctx: CoreContext, actor: Actor, input: BurstTemplateInput): Promise<BurstTemplate> {
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO burst_template (id, user_id, name, payment_method_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      actor.userId,
      v.requiredText('name', input.name, 60),
      await validPaymentMethod(tx, actor, input.paymentMethodId),
      now,
      now,
    ]);
    await writeLines(ctx, tx, actor, id, input.lines);
  });
  return getBurstTemplate(ctx, actor, id);
}

/** Modifie un modèle. Des lignes fournies remplacent toutes les lignes. */
export async function updateBurstTemplate(
  ctx: CoreContext,
  actor: Actor,
  templateId: string,
  input: Partial<BurstTemplateInput>,
): Promise<BurstTemplate> {
  await ctx.db.transaction(async (tx) => {
    await findTemplateRow(tx, actor, templateId);
    if (input.name !== undefined) await tx.execute('UPDATE burst_template SET name = ? WHERE id = ?', [v.requiredText('name', input.name, 60), templateId]);
    if (input.paymentMethodId !== undefined) {
      await tx.execute('UPDATE burst_template SET payment_method_id = ? WHERE id = ?', [await validPaymentMethod(tx, actor, input.paymentMethodId), templateId]);
    }
    if (input.lines !== undefined) {
      await tx.execute('DELETE FROM burst_template_line WHERE template_id = ?', [templateId]);
      await writeLines(ctx, tx, actor, templateId, input.lines);
    }
    await tx.execute('UPDATE burst_template SET updated_at = ? WHERE id = ?', [toIso(ctx.clock.now()), templateId]);
  });
  return getBurstTemplate(ctx, actor, templateId);
}

/** Supprime un modèle : c'est un simple réglage local, les ventes déjà faites ne changent pas. */
export async function deleteBurstTemplate(ctx: CoreContext, actor: Actor, templateId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await findTemplateRow(tx, actor, templateId);
    await tx.execute('DELETE FROM burst_template WHERE id = ?', [templateId]);
  });
}

export async function getBurstTemplate(ctx: CoreContext, actor: Actor, templateId: string): Promise<BurstTemplate> {
  return loadTemplate(ctx.db, await findTemplateRow(ctx.db, actor, templateId));
}

/** Les modèles de l'utilisateur connecté, par nom. */
export async function listBurstTemplates(ctx: CoreContext, actor: Actor): Promise<BurstTemplate[]> {
  const { rows } = await ctx.db.execute('SELECT * FROM burst_template WHERE user_id = ? ORDER BY name COLLATE NOCASE', [actor.userId]);
  return Promise.all(rows.map((r) => loadTemplate(ctx.db, r)));
}

/**
 * Un clic : enregistre immédiatement une vente complète avec tous les articles du modèle.
 * Le client est facultatif ; le boss peut indiquer l'employé ayant fait la vente.
 */
export async function recordBurstSale(
  ctx: CoreContext,
  actor: Actor,
  templateId: string,
  options: { customerId?: string | null; employeeId?: string | null } = {},
): Promise<Sale> {
  const template = await getBurstTemplate(ctx, actor, templateId);
  return createSale(ctx, actor, {
    lines: template.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice ?? undefined })),
    paymentMethodId: template.paymentMethodId,
    customerId: options.customerId,
    employeeId: options.employeeId,
    entryMode: 'BURST',
  });
}

/**
 * « Annuler la dernière vente » : annule la vente en rafale la plus récente saisie par cet
 * utilisateur sur ce téléphone, avec un motif automatique. Mêmes règles qu'une annulation :
 * un employé ne peut plus annuler une vente déjà reçue par le boss.
 */
export async function undoLastBurstSale(ctx: CoreContext, actor: Actor): Promise<Sale> {
  const { rows } = await ctx.db.execute(
    `SELECT id FROM sale
     WHERE entered_by_id = ? AND device_id = ? AND entry_mode = 'BURST' AND status = 'ACTIVE'
     ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    [actor.userId, ctx.device.id],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Aucune vente en rafale à annuler.');
  return cancelSale(ctx, actor, str(rows[0], 'id'), UNDO_BURST_REASON);
}
