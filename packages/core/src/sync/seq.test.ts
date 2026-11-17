import { describe, expect, it } from 'vitest';

import { createTestContext } from '../testing/context';
import { nextSeq } from './seq';

describe('nextSeq', () => {
  it('attribue des valeurs croissantes sur le téléphone du boss', async () => {
    const ctx = await createTestContext({ isBoss: true });
    const values = await ctx.db.transaction(async (tx) => [await nextSeq(ctx, tx), await nextSeq(ctx, tx), await nextSeq(ctx, tx)]);
    expect(values).toEqual([1, 2, 3]);
  });

  it('reprend le compteur là où il était (persistant)', async () => {
    const ctx = await createTestContext({ isBoss: true });
    await ctx.db.transaction((tx) => nextSeq(ctx, tx));
    await ctx.db.transaction((tx) => nextSeq(ctx, tx));
    expect(await ctx.db.transaction((tx) => nextSeq(ctx, tx))).toBe(3);
  });

  it("n'avance pas si la transaction est annulée", async () => {
    const ctx = await createTestContext({ isBoss: true });
    await ctx.db.transaction((tx) => nextSeq(ctx, tx));
    await expect(
      ctx.db.transaction(async (tx) => {
        await nextSeq(ctx, tx);
        throw new Error('annulée');
      }),
    ).rejects.toThrow();
    expect(await ctx.db.transaction((tx) => nextSeq(ctx, tx))).toBe(2);
  });

  it("renvoie null sur un téléphone d'employé (le boss attribuera le seq)", async () => {
    const ctx = await createTestContext({ isBoss: false });
    expect(await ctx.db.transaction((tx) => nextSeq(ctx, tx))).toBeNull();
  });

  it("signale clairement un curseur absent", async () => {
    const ctx = await createTestContext({ isBoss: true });
    const other = { ...ctx, device: { id: 'appareil-non-initialise', isBoss: true } };
    await expect(ctx.db.transaction((tx) => nextSeq(other, tx))).rejects.toThrow(/ensureSyncState/);
  });
});
