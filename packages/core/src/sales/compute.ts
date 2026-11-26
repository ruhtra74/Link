/**
 * Calcul des montants d'une vente — fonction pure, sans base de données.
 *
 * - Chaque ligne : total = quantité × prix pratiqué ; écart = (prix pratiqué − prix de référence) × quantité.
 * - Total de référence = somme des quantités × prix de référence.
 * - Le total encaissé peut être ajusté globalement : ajustement = total encaissé − somme des lignes.
 * Tous les montants sont des FCFA entiers.
 */
import type { ItemType } from '../catalog/types';
import { DomainError } from '../errors';
import * as v from '../shared/validation';

/** Un article tel qu'il est au moment de la vente (copié dans la ligne). */
export interface ItemSnapshot {
  id: string;
  name: string;
  type: ItemType;
  referencePrice: number;
}

export interface LineDraft {
  item: ItemSnapshot;
  quantity: number;
  /** Prix pratiqué ; par défaut le prix de référence. */
  unitPrice?: number;
}

export interface ComputedLine {
  itemId: string;
  itemName: string;
  itemType: ItemType;
  quantity: number;
  referencePrice: number;
  unitPrice: number;
  lineTotal: number;
  priceGap: number;
}

export interface ComputedSale {
  lines: ComputedLine[];
  referenceTotal: number;
  /** Somme des lignes, avant ajustement global. */
  linesTotal: number;
  adjustment: number;
  totalAmount: number;
}

export const MAX_QUANTITY = 100_000;

export function computeSale(drafts: readonly LineDraft[], totalAmount?: number): ComputedSale {
  if (drafts.length === 0) throw new DomainError('VALIDATION', 'Une vente contient au moins un article.', { field: 'lines' });

  const lines = drafts.map((d, i): ComputedLine => {
    const quantity = v.integerInRange(`lines[${i}].quantity`, d.quantity, 1, MAX_QUANTITY);
    const unitPrice = v.amount(`lines[${i}].unitPrice`, d.unitPrice ?? d.item.referencePrice);
    return {
      itemId: d.item.id,
      itemName: d.item.name,
      itemType: d.item.type,
      quantity,
      referencePrice: d.item.referencePrice,
      unitPrice,
      lineTotal: quantity * unitPrice,
      priceGap: (unitPrice - d.item.referencePrice) * quantity,
    };
  });

  const linesTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const referenceTotal = lines.reduce((s, l) => s + l.quantity * l.referencePrice, 0);
  const total = totalAmount === undefined ? linesTotal : v.amount('totalAmount', totalAmount);
  return { lines, referenceTotal, linesTotal, adjustment: total - linesTotal, totalAmount: total };
}
