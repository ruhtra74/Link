import type { ItemType } from '../catalog/types';
import type { Row } from '../db/types';
import { num, str, strOrNull } from '../shared/sql';

export type EntryMode = 'MANUAL' | 'BURST';
export type SaleStatus = 'ACTIVE' | 'CANCELLED';

export interface SaleLine {
  id: string;
  itemId: string;
  /** Copie figée au moment de la vente : l'historique ne change pas si le catalogue change. */
  itemName: string;
  itemType: ItemType;
  quantity: number;
  /** Prix de référence copié au moment de la vente. */
  referencePrice: number;
  /** Prix réellement pratiqué. */
  unitPrice: number;
  lineTotal: number;
  /** Écart total avec la référence : négatif = remise, positif = majoration. */
  priceGap: number;
  /** Coût d'achat unitaire fixé par le boss à la réception. Toujours `null` pour un employé. */
  unitCost: number | null;
}

export interface Sale {
  id: string;
  companyId: string;
  /** Exercice attribué par le boss à la réception ; `null` sur le téléphone de l'employé avant. */
  fiscalYearId: string | null;
  /** Employé à qui la vente est attribuée (le boss s'il la fait lui-même). */
  employeeId: string;
  /** Personne qui a saisi la vente (le boss quand il saisit pour un employé). */
  enteredById: string;
  deviceId: string;
  customerId: string | null;
  paymentMethodId: string | null;
  /** Heure de l'appareil au moment de la saisie. */
  occurredAt: string;
  referenceTotal: number;
  adjustment: number;
  totalAmount: number;
  note: string | null;
  entryMode: EntryMode;
  status: SaleStatus;
  cancelReason: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  /** Accusé de réception du boss. `null` : en attente, l'employé peut encore corriger. */
  syncedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: SaleLine[];
}

export const toSaleLine = (r: Row): SaleLine => ({
  id: str(r, 'id'),
  itemId: str(r, 'item_id'),
  itemName: str(r, 'item_name'),
  itemType: str(r, 'item_type') as ItemType,
  quantity: num(r, 'quantity'),
  referencePrice: num(r, 'reference_price'),
  unitPrice: num(r, 'unit_price'),
  lineTotal: num(r, 'line_total'),
  priceGap: num(r, 'price_gap'),
  unitCost: r.unit_cost == null ? null : num(r, 'unit_cost'),
});

export const toSale = (r: Row, lines: SaleLine[]): Sale => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  fiscalYearId: strOrNull(r, 'fiscal_year_id'),
  employeeId: str(r, 'employee_id'),
  enteredById: str(r, 'entered_by_id'),
  deviceId: str(r, 'device_id'),
  customerId: strOrNull(r, 'customer_id'),
  paymentMethodId: strOrNull(r, 'payment_method_id'),
  occurredAt: str(r, 'occurred_at'),
  referenceTotal: num(r, 'reference_total'),
  adjustment: num(r, 'adjustment'),
  totalAmount: num(r, 'total_amount'),
  note: strOrNull(r, 'note'),
  entryMode: str(r, 'entry_mode') as EntryMode,
  status: str(r, 'status') as SaleStatus,
  cancelReason: strOrNull(r, 'cancel_reason'),
  cancelledBy: strOrNull(r, 'cancelled_by'),
  cancelledAt: strOrNull(r, 'cancelled_at'),
  syncedAt: strOrNull(r, 'synced_at'),
  version: num(r, 'version'),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
  lines,
});
