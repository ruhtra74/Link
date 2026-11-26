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

export { localDate, toIso, type Actor, type Clock, type CoreContext, type PasswordHasher, type Role } from './context';
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

// Catalogue, modes de paiement, clients
export * from './catalog/types';
export { createCategory, listCategories, updateCategory } from './catalog/categories';
export {
  createProduct,
  createService,
  getItem,
  getPurchasePrices,
  listItems,
  setItemArchived,
  setPurchasePrice,
  updateItem,
  type ItemFilter,
  type ItemUpdateInput,
  type ProductInput,
  type ServiceInput,
} from './catalog/items';
export { createPaymentMethod, listPaymentMethods, updatePaymentMethod } from './catalog/payment-methods';
export { createCustomer, searchCustomers, updateCustomer } from './catalog/customers';
export { MAX_AMOUNT } from './shared/validation';

// Ventes
export * from './sales/types';
export { computeSale, MAX_QUANTITY, type ComputedLine, type ComputedSale, type ItemSnapshot, type LineDraft } from './sales/compute';
export {
  cancelSale,
  correctSale,
  createSale,
  finalizeSaleOnBoss,
  getSale,
  listSales,
  type SaleCorrectionInput,
  type SaleFilter,
  type SaleInput,
  type SaleLineInput,
} from './sales/sales';

// Stock et alertes
export {
  computeStock,
  disableStockTracking,
  enableStockTracking,
  getDisplayedStock,
  listStockMovements,
  MAX_STOCK_QUANTITY,
  recordInventory,
  recordStockEntry,
  recordStockLoss,
  setStockAlertThreshold,
  type StockMovement,
  type StockMovementType,
} from './stock/stock';
export { listAlerts, markAlertRead, type Alert, type AlertType } from './alerts/alerts';

// Mode rafale
export {
  createBurstTemplate,
  deleteBurstTemplate,
  getBurstTemplate,
  listBurstTemplates,
  recordBurstSale,
  undoLastBurstSale,
  updateBurstTemplate,
  UNDO_BURST_REASON,
  type BurstTemplate,
  type BurstTemplateInput,
  type BurstTemplateLine,
} from './burst/burst';

// Indicateurs (tableau de bord, récapitulatif)
export { previousPeriod, resolvePeriod, type PeriodInput, type PeriodPreset, type ResolvedPeriod } from './analytics/periods';
export {
  getDiscountReport,
  getEmployeeActivity,
  getItemPerformance,
  getMySalesSummary,
  getRevenueSummary,
  type CategorySales,
  type DashboardScope,
  type DiscountReport,
  type EmployeeActivity,
  type ItemPerformance,
  type ItemSales,
  type PeriodTotals,
  type RevenueFigures,
  type RevenueSummary,
} from './analytics/dashboard';

// Journal d'audit
export {
  listAuditLog,
  type AuditAction,
  type AuditedEntity,
  type AuditEntry,
  type AuditFilter,
  type Snapshot,
} from './audit/audit';

// Dépenses
export {
  cancelExpense,
  createExpense,
  getExpense,
  listExpenses,
  updateExpense,
  type Expense,
  type ExpenseInput,
  type ExpenseList,
} from './expenses/expenses';
