/**
 * Clients, toujours facultatifs (une vente sans client est une vente à un client anonyme).
 * Tout le monde peut en créer un rapidement pendant la saisie, y compris en mode rafale ;
 * les clients créés par un employé partent au boss à la synchronisation.
 * La fusion des doublons est reportée (voir docs/specs, « Éléments mis de côté »).
 */
import { audited, recordAudit, snapshot } from '../audit/audit';
import { toIso, type Actor, type CoreContext } from '../context';
import type { SqlExecutor } from '../db/types';
import { DomainError } from '../errors';
import { requireBoss } from '../shared/permissions';
import { setClause } from '../shared/sql';
import * as v from '../shared/validation';
import { nextSeq } from '../sync/seq';
import { toCustomer, type Customer } from './types';

export async function findCustomer(tx: SqlExecutor, companyId: string, id: string): Promise<Customer> {
  const { rows } = await tx.execute('SELECT * FROM customer WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Client introuvable.', { field: 'customerId' });
  return toCustomer(rows[0]);
}

export async function createCustomer(ctx: CoreContext, actor: Actor, input: { name: string; phone?: string | null }): Promise<Customer> {
  const id = ctx.ids.newId();
  const now = toIso(ctx.clock.now());
  await ctx.db.transaction(async (tx) => {
    await tx.execute(`INSERT INTO customer (id, company_id, name, phone, created_by, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      actor.companyId,
      v.requiredText('name', input.name),
      v.optionalText('phone', input.phone, 30),
      actor.userId,
      await nextSeq(ctx, tx),
      now,
      now,
    ]);
    await recordAudit(ctx, tx, actor, { action: 'CUSTOMER_CREATE', entityType: 'customer', entityId: id, after: await snapshot(tx, 'customer', id) });
  });
  return findCustomer(ctx.db, actor.companyId, id);
}

/** Corrige le nom ou le téléphone d'un client (boss : il fait foi pour les données partagées). */
export async function updateCustomer(
  ctx: CoreContext,
  actor: Actor,
  id: string,
  input: { name?: string; phone?: string | null },
): Promise<Customer> {
  requireBoss(actor);
  await ctx.db.transaction(async (tx) => {
    await findCustomer(tx, actor.companyId, id);
    const set = setClause({
      name: input.name !== undefined ? v.requiredText('name', input.name) : undefined,
      phone: input.phone !== undefined ? v.optionalText('phone', input.phone, 30) : undefined,
      updated_at: toIso(ctx.clock.now()),
      seq: (await nextSeq(ctx, tx)) ?? undefined,
    });
    await audited(ctx, tx, actor, { action: 'CUSTOMER_UPDATE', entityType: 'customer', entityId: id }, () =>
      tx.execute(`UPDATE customer SET ${set.sql} WHERE id = ?`, [...set.params, id]),
    );
  });
  return findCustomer(ctx.db, actor.companyId, id);
}

/** Recherche par nom ou téléphone, pour choisir un client pendant la saisie. */
export async function searchCustomers(ctx: CoreContext, actor: Actor, query = '', limit = 30): Promise<Customer[]> {
  const q = query.trim() ? `%${query.trim()}%` : null;
  const { rows } = await ctx.db.execute(
    `SELECT * FROM customer WHERE company_id = ? AND (? IS NULL OR name LIKE ? OR phone LIKE ?) ORDER BY name COLLATE NOCASE LIMIT ?`,
    [actor.companyId, q, q, q, limit],
  );
  return rows.map(toCustomer);
}
