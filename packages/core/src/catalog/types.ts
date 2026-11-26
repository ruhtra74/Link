import type { Row } from '../db/types';
import { bool, num, str, strOrNull } from '../shared/sql';

export type ItemType = 'PRODUCT' | 'SERVICE';
export type CategoryScope = 'PRODUCT' | 'SERVICE' | 'BOTH';

export interface Category {
  id: string;
  companyId: string;
  name: string;
  appliesTo: CategoryScope;
  isActive: boolean;
}

/**
 * Un article du catalogue. Ne contient jamais le prix d'achat (table séparée, boss seulement).
 * `stockAlertThreshold` vaut toujours `null` pour un employé.
 */
export interface Item {
  id: string;
  companyId: string;
  categoryId: string | null;
  type: ItemType;
  name: string;
  description: string | null;
  photo: string | null;
  referencePrice: number;
  internalRef: string | null;
  durationMinutes: number | null;
  isArchived: boolean;
  isFavorite: boolean;
  isStockTracked: boolean;
  stockQuantity: number;
  stockAlertThreshold: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentMethod {
  id: string;
  companyId: string;
  name: string;
  isActive: boolean;
}

export interface Customer {
  id: string;
  companyId: string;
  name: string;
  phone: string | null;
  createdBy: string;
  createdAt: string;
}

export const toCategory = (r: Row): Category => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  name: str(r, 'name'),
  appliesTo: str(r, 'applies_to') as CategoryScope,
  isActive: bool(r, 'is_active'),
});

export const toItem = (r: Row): Item => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  categoryId: strOrNull(r, 'category_id'),
  type: str(r, 'type') as ItemType,
  name: str(r, 'name'),
  description: strOrNull(r, 'description'),
  photo: strOrNull(r, 'photo'),
  referencePrice: num(r, 'reference_price'),
  internalRef: strOrNull(r, 'internal_ref'),
  durationMinutes: r.duration_minutes == null ? null : num(r, 'duration_minutes'),
  isArchived: bool(r, 'is_archived'),
  isFavorite: bool(r, 'is_favorite'),
  isStockTracked: bool(r, 'is_stock_tracked'),
  stockQuantity: num(r, 'stock_quantity'),
  stockAlertThreshold: r.stock_alert_threshold == null ? null : num(r, 'stock_alert_threshold'),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

export const toPaymentMethod = (r: Row): PaymentMethod => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  name: str(r, 'name'),
  isActive: bool(r, 'is_active'),
});

export const toCustomer = (r: Row): Customer => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  name: str(r, 'name'),
  phone: strOrNull(r, 'phone'),
  createdBy: str(r, 'created_by'),
  createdAt: str(r, 'created_at'),
});
