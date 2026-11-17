/**
 * @link/core — règles métier et protocole de synchronisation de Link.
 *
 * Ce paquet ne dépend ni de React Native ni de Node : il reçoit la base, l'horloge et
 * le générateur d'identifiants de l'application (voir `CoreContext`). Les utilitaires
 * de test (`src/testing`) ne sont volontairement pas exportés.
 */
export type { Database, QueryResult, Row, SqlExecutor, SqlValue } from './db/types';
export { prepareDatabase, schemaVersion } from './db/migrate';
export { migrations, type Migration } from './db/migrations';

export { toIso, type Actor, type Clock, type CoreContext, type PasswordHasher, type Role } from './context';
export { DomainError, isDomainError, type ErrorCode } from './errors';
export { createIdGenerator, uuidv7, UUID_V7_PATTERN, type IdGenerator, type RandomBytes } from './ids';
export { ensureSyncState, nextSeq } from './sync/seq';

// Entreprise et comptes
export * from './accounts/types';
export {
  getCompany,
  setupCompany,
  updateCompany,
  type CompanyProfileInput,
  type CompanySettingsInput,
  type SetupCompanyInput,
} from './accounts/company';
export {
  changePassword,
  createEmployee,
  generateTemporaryPassword,
  getMe,
  listUsers,
  resetEmployeePassword,
  setEmployeeActive,
  updateEmployee,
  updateOwnProfile,
  type EmployeeInput,
  type EmployeeUpdateInput,
  type ProfileInput,
} from './accounts/users';
export { listDevices, revokeDevice } from './accounts/devices';
export { authenticate, type AuthResult } from './accounts/auth';
export { PASSWORD_MIN_LENGTH } from './shared/validation';

// Exercices
export {
  closeAndOpenFiscalYear,
  closeFiscalYear,
  getClosureCheck,
  getOpenFiscalYear,
  listFiscalYears,
  openFiscalYear,
  updateFiscalYear,
  type ClosureCheckEntry,
  type FiscalYear,
  type FiscalYearInput,
} from './fiscal-years/fiscal-years';
