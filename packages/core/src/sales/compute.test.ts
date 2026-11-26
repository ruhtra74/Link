import { describe, expect, it } from 'vitest';

import { computeSale, type ItemSnapshot } from './compute';

const coupe: ItemSnapshot = { id: 'coupe', name: 'Coupe homme', type: 'SERVICE', referencePrice: 2000 };
const shampoing: ItemSnapshot = { id: 'sh', name: 'Shampoing', type: 'PRODUCT', referencePrice: 2500 };

describe('computeSale', () => {
  it('au prix de référence : pas d’écart, pas d’ajustement', () => {
    const s = computeSale([{ item: coupe, quantity: 1 }, { item: shampoing, quantity: 2 }]);
    expect(s).toMatchObject({ referenceTotal: 7000, linesTotal: 7000, adjustment: 0, totalAmount: 7000 });
    expect(s.lines.map((l) => [l.lineTotal, l.priceGap])).toEqual([
      [2000, 0],
      [5000, 0],
    ]);
  });

  it('prix négocié à la baisse (remise) et à la hausse (majoration), par ligne', () => {
    const s = computeSale([
      { item: shampoing, quantity: 2, unitPrice: 2000 },
      { item: coupe, quantity: 1, unitPrice: 2500 },
    ]);
    expect(s.lines.map((l) => l.priceGap)).toEqual([-1000, 500]);
    expect(s).toMatchObject({ referenceTotal: 7000, linesTotal: 6500, totalAmount: 6500 });
  });

  it('ajustement global du total encaissé', () => {
    const s = computeSale([{ item: coupe, quantity: 1 }, { item: shampoing, quantity: 1 }], 4000);
    expect(s).toMatchObject({ linesTotal: 4500, adjustment: -500, totalAmount: 4000 });
  });

  it('un article offert (prix 0) est accepté', () => {
    expect(computeSale([{ item: shampoing, quantity: 1, unitPrice: 0 }]).totalAmount).toBe(0);
  });

  it.each([
    ['aucune ligne', [], undefined, 'lines'],
    ['quantité nulle', [{ item: coupe, quantity: 0 }], undefined, 'lines[0].quantity'],
    ['quantité à virgule', [{ item: coupe, quantity: 1.5 }], undefined, 'lines[0].quantity'],
    ['prix négatif', [{ item: coupe, quantity: 1, unitPrice: -1 }], undefined, 'lines[0].unitPrice'],
    ['total négatif', [{ item: coupe, quantity: 1 }], -1, 'totalAmount'],
    ['total à virgule', [{ item: coupe, quantity: 1 }], 1999.5, 'totalAmount'],
  ])('refuse : %s', (_, lines, total, field) => {
    expect(() => computeSale(lines, total)).toThrow(expect.objectContaining({ code: 'VALIDATION', details: { field } }));
  });
});
