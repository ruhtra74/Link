import type { Role } from '../context';
import type { Row } from '../db/types';
import { bool, num, str, strOrNull } from '../shared/sql';

export type HistoryRetentionMode = 'KEEP' | 'DISAPPEAR';
export type Language = 'fr' | 'en';
export type Platform = 'IOS' | 'ANDROID';

export interface Company {
  id: string;
  name: string;
  logo: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  currency: 'XOF';
  activityType: string | null;
  phone: string | null;
  address: string | null;
  historyRetentionMode: HistoryRetentionMode;
  stockEnabled: boolean;
  backupCopyRetentionDays: number;
  settingsUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Un compte. Le mot de passe haché n'est jamais exposé hors du module. */
export interface User {
  id: string;
  companyId: string;
  login: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  photo: string | null;
  language: Language;
  role: Role;
  mustChangePassword: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  companyId: string;
  userId: string;
  label: string | null;
  platform: Platform;
  status: 'ACTIVE' | 'REVOKED';
  pairedAt: string;
  lastLoginAt: string | null;
  revokedAt: string | null;
  wipePending: boolean;
}

export const toCompany = (r: Row): Company => ({
  id: str(r, 'id'),
  name: str(r, 'name'),
  logo: strOrNull(r, 'logo'),
  primaryColor: strOrNull(r, 'primary_color'),
  secondaryColor: strOrNull(r, 'secondary_color'),
  currency: 'XOF',
  activityType: strOrNull(r, 'activity_type'),
  phone: strOrNull(r, 'phone'),
  address: strOrNull(r, 'address'),
  historyRetentionMode: str(r, 'history_retention_mode') as HistoryRetentionMode,
  stockEnabled: bool(r, 'stock_enabled'),
  backupCopyRetentionDays: num(r, 'backup_copy_retention_days'),
  settingsUpdatedAt: strOrNull(r, 'settings_updated_at'),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

export const toUser = (r: Row): User => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  login: str(r, 'login'),
  firstName: str(r, 'first_name'),
  lastName: str(r, 'last_name'),
  phone: strOrNull(r, 'phone'),
  photo: strOrNull(r, 'photo'),
  language: str(r, 'language') as Language,
  role: str(r, 'role') as Role,
  mustChangePassword: bool(r, 'must_change_password'),
  isActive: bool(r, 'is_active'),
  createdAt: str(r, 'created_at'),
  updatedAt: str(r, 'updated_at'),
});

export const toDevice = (r: Row): Device => ({
  id: str(r, 'id'),
  companyId: str(r, 'company_id'),
  userId: str(r, 'user_id'),
  label: strOrNull(r, 'label'),
  platform: str(r, 'platform') as Platform,
  status: str(r, 'status') as Device['status'],
  pairedAt: str(r, 'paired_at'),
  lastLoginAt: strOrNull(r, 'last_login_at'),
  revokedAt: strOrNull(r, 'revoked_at'),
  wipePending: bool(r, 'wipe_pending'),
});
