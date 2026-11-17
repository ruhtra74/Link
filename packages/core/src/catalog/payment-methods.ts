/**
 * Modes de paiement (espèces, mobile money, carte…), liste définie par le boss.
 * Un mode n'est jamais supprimé : on le désactive (les ventes passées le gardent).
 */
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss, requireBossDevice } from '../shared/permissions';
import { setClause, toDb } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';
import { toPaymentMethod, type PaymentMethod } from './types';

export async function findPaymentMethod(tx: SqlExecutor, companyId: string, id: string): Promise<PaymentMethod> {
  const { rows } = await tx.execute('SELECT * FROM payment_method WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Mode de paiement introuvable.', { field: 'paymentMethodId' });
  return toPaymentMethod(rows[0]);
}

export async function createPaymentMethod(ctx: CoreContext, actor: Actor, input: { name: string }): Promise<PaymentMethod> {
  requireBoss(actor);
  requireBossDevice(ctx);
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO payment_method (id, company_id, name, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      actor.companyId,
      v.requiredText('name', input.name, 40),
      await nextSeq(ctx, tx),
      now,
      now,
    ]);
  });
  return findPaymentMethod(ctx.db, actor.companyId, id);
}

export async function updatePaymentMethod(
  ctx: CoreContext,
  actor: Actor,
  id: string,
  input: { name?: string; isActive?: boolean },
): Promise<PaymentMethod> {
  requireBoss(actor);
  requireBossDevice(ctx);
  await ctx.db.transaction(async (tx) => {
    await findPaymentMethod(tx, actor.companyId, id);
    const set = setClause({
      name: input.name !== undefined ? v.requiredText('name', input.name, 40) : undefined,
      is_active: input.isActive !== undefined ? toDb(input.isActive) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: await nextSeq(ctx, tx),
    });
    await tx.execute(`UPDATE payment_method SET ${set.sql} WHERE id = ?`, [...set.params, id]);
  });
  return findPaymentMethod(ctx.db, actor.companyId, id);
}

/** Modes de paiement, par nom. Les inactifs sont exclus par défaut (saisie). */
export async function listPaymentMethods(ctx: CoreContext, actor: Actor, options: { includeInactive?: boolean } = {}): Promise<PaymentMethod[]> {
  const { rows } = await ctx.db.execute(
    `SELECT * FROM payment_method WHERE company_id = ? AND (? OR is_active = 1) ORDER BY name COLLATE NOCASE`,
    [actor.companyId, options.includeInactive ? 1 : 0],
  );
  return rows.map(toPaymentMethod);
}
