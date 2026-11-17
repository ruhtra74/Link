/**
 * Schéma v1 — traduction de docs/specs/link_modele_donnees.mermaid.
 *
 * Conventions
 * - Identifiants : UUID v7 (TEXT). Dates : ISO 8601 UTC (TEXT). Montants : FCFA entiers.
 *   Quantités : entiers. Booléens : INTEGER 0/1.
 * - Le même schéma existe sur tous les téléphones ; les tables réservées au boss restent
 *   simplement vides chez les employés.
 * - `seq` : compteur de modification attribué par le téléphone du boss (curseur de synchro).
 *
 * Clés étrangères — règle importante
 * Un téléphone d'employé n'a qu'une partie des données : son propre compte et son propre
 * appareil, mais pas ceux du boss ni des collègues. Une vente saisie par le boss au nom
 * d'un employé référence pourtant le compte et l'appareil du boss. On ne déclare donc une
 * clé étrangère que vers des données présentes sur TOUS les appareils (entreprise,
 * exercices, catalogue, clients, modes de paiement) ou à l'intérieur d'un même ensemble
 * (vente → lignes). Les références vers USER ou DEVICE qui peuvent manquer sont de simples
 * colonnes, vérifiées par le code. Toutes les clés sont différées (vérifiées au COMMIT),
 * pour qu'une synchro puisse insérer les lignes dans n'importe quel ordre.
 */
import type { Migration } from './types';

const FK = 'DEFERRABLE INITIALLY DEFERRED';
const bool = (name: string, defaultValue: 0 | 1) =>
  `${name} INTEGER NOT NULL DEFAULT ${defaultValue} CHECK (${name} IN (0, 1))`;

export const migration0001: Migration = {
  version: 1,
  name: 'schéma initial',
  statements: [
    // ---------- ENTREPRISE, COMPTES, APPAREILS ----------
    `CREATE TABLE company (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logo TEXT,
      primary_color TEXT,
      secondary_color TEXT,
      currency TEXT NOT NULL DEFAULT 'XOF' CHECK (currency = 'XOF'),
      activity_type TEXT,
      phone TEXT,
      address TEXT,
      history_retention_mode TEXT NOT NULL DEFAULT 'KEEP' CHECK (history_retention_mode IN ('KEEP', 'DISAPPEAR')),
      ${bool('stock_enabled', 0)},
      backup_copy_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (backup_copy_retention_days > 0),
      boss_public_key TEXT,
      settings_updated_at TEXT,
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE user (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      login TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      photo TEXT,
      language TEXT NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
      role TEXT NOT NULL CHECK (role IN ('BOSS', 'EMPLOYEE')),
      ${bool('must_change_password', 0)},
      ${bool('is_active', 1)},
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (company_id, login)
    )`,

    `CREATE TABLE device (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      user_id TEXT NOT NULL REFERENCES user (id) ${FK},
      label TEXT,
      platform TEXT NOT NULL CHECK (platform IN ('IOS', 'ANDROID')),
      public_key TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
      paired_at TEXT NOT NULL,
      last_login_at TEXT,
      revoked_at TEXT,
      ${bool('wipe_pending', 0)},
      wipe_confirmed_at TEXT,
      last_sync_at TEXT,
      seq INTEGER
    )`,
    `CREATE INDEX device_user ON device (user_id)`,

    // ---------- EXERCICES ----------
    `CREATE TABLE fiscal_year (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      seq INTEGER,
      CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL))
    )`,
    // Un seul exercice ouvert par entreprise.
    `CREATE UNIQUE INDEX fiscal_year_one_open ON fiscal_year (company_id) WHERE status = 'OPEN'`,

    // ---------- CATALOGUE ET STOCK ----------
    `CREATE TABLE category (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      name TEXT NOT NULL,
      applies_to TEXT NOT NULL CHECK (applies_to IN ('PRODUCT', 'SERVICE', 'BOTH')),
      ${bool('is_active', 1)},
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE item (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      category_id TEXT REFERENCES category (id) ${FK},
      type TEXT NOT NULL CHECK (type IN ('PRODUCT', 'SERVICE')),
      name TEXT NOT NULL,
      description TEXT,
      photo TEXT,
      reference_price INTEGER NOT NULL CHECK (reference_price >= 0),
      internal_ref TEXT,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      ${bool('is_archived', 0)},
      ${bool('is_favorite', 0)},
      ${bool('is_stock_tracked', 0)},
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      stock_alert_threshold INTEGER CHECK (stock_alert_threshold IS NULL OR stock_alert_threshold >= 0),
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Un service n'a pas de stock.
      CHECK (type = 'PRODUCT' OR is_stock_tracked = 0)
    )`,
    `CREATE INDEX item_category ON item (category_id)`,

    // Prix d'achat : boss seulement.
    `CREATE TABLE item_cost (
      item_id TEXT PRIMARY KEY REFERENCES item (id) ON DELETE CASCADE ${FK},
      purchase_price INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0),
      updated_at TEXT NOT NULL
    )`,

    // ---------- CLIENTS ET PAIEMENT ----------
    `CREATE TABLE customer (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      name TEXT NOT NULL,
      phone TEXT,
      created_by TEXT NOT NULL,
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE payment_method (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      name TEXT NOT NULL,
      ${bool('is_active', 1)},
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    // ---------- VENTES ----------
    `CREATE TABLE sale (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      fiscal_year_id TEXT REFERENCES fiscal_year (id) ${FK},
      employee_id TEXT NOT NULL,
      entered_by_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      customer_id TEXT REFERENCES customer (id) ${FK},
      payment_method_id TEXT REFERENCES payment_method (id) ${FK},
      occurred_at TEXT NOT NULL,
      reference_total INTEGER NOT NULL,
      adjustment INTEGER NOT NULL DEFAULT 0,
      total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
      note TEXT,
      entry_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (entry_mode IN ('MANUAL', 'BURST')),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
      cancel_reason TEXT,
      cancelled_by TEXT,
      cancelled_at TEXT,
      synced_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      seq INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- Une annulation exige un motif, un auteur et une date.
      CHECK (status = 'ACTIVE' OR (cancel_reason IS NOT NULL AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
    )`,
    `CREATE INDEX sale_year_date ON sale (fiscal_year_id, occurred_at)`,
    `CREATE INDEX sale_employee ON sale (employee_id, occurred_at)`,
    `CREATE INDEX sale_pending ON sale (device_id) WHERE synced_at IS NULL`,
    `CREATE INDEX sale_seq ON sale (seq)`,

    `CREATE TABLE sale_line (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sale (id) ON DELETE CASCADE ${FK},
      item_id TEXT NOT NULL REFERENCES item (id) ${FK},
      item_name TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('PRODUCT', 'SERVICE')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      reference_price INTEGER NOT NULL CHECK (reference_price >= 0),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
      line_total INTEGER NOT NULL,
      price_gap INTEGER NOT NULL,
      unit_cost INTEGER CHECK (unit_cost IS NULL OR unit_cost >= 0)
    )`,
    `CREATE INDEX sale_line_sale ON sale_line (sale_id)`,
    `CREATE INDEX sale_line_item ON sale_line (item_id)`,

    // Mouvements de stock : boss seulement. Source de vérité du stock.
    `CREATE TABLE stock_movement (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      item_id TEXT NOT NULL REFERENCES item (id) ${FK},
      type TEXT NOT NULL CHECK (type IN ('SALE', 'SALE_CORRECTION', 'ENTRY', 'LOSS', 'INVENTORY')),
      quantity_delta INTEGER,
      counted_quantity INTEGER,
      occurred_at TEXT NOT NULL,
      sale_line_id TEXT REFERENCES sale_line (id) ${FK},
      user_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      CHECK (
        (type = 'INVENTORY' AND counted_quantity IS NOT NULL AND quantity_delta IS NULL)
        OR (type <> 'INVENTORY' AND quantity_delta IS NOT NULL AND counted_quantity IS NULL)
      ),
      CHECK (type NOT IN ('SALE', 'SALE_CORRECTION') OR sale_line_id IS NOT NULL)
    )`,
    `CREATE INDEX stock_movement_item_date ON stock_movement (item_id, occurred_at)`,
    // Une ligne de vente reçue deux fois (renvoi, copie de secours) ne crée qu'un seul mouvement SALE.
    `CREATE UNIQUE INDEX stock_movement_one_sale ON stock_movement (sale_line_id) WHERE type = 'SALE'`,

    // ---------- MODE RAFALE (LOCAL) ----------
    `CREATE TABLE burst_template (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user (id) ${FK},
      name TEXT NOT NULL,
      payment_method_id TEXT REFERENCES payment_method (id) ${FK},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE burst_template_line (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES burst_template (id) ON DELETE CASCADE ${FK},
      item_id TEXT NOT NULL REFERENCES item (id) ${FK},
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
    )`,

    // ---------- DÉPENSES (BOSS) ----------
    `CREATE TABLE expense (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      fiscal_year_id TEXT NOT NULL REFERENCES fiscal_year (id) ${FK},
      name TEXT NOT NULL,
      description TEXT,
      amount INTEGER NOT NULL CHECK (amount > 0),
      expense_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
      cancel_reason TEXT,
      created_by TEXT NOT NULL REFERENCES user (id) ${FK},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status = 'ACTIVE' OR cancel_reason IS NOT NULL)
    )`,
    `CREATE INDEX expense_year ON expense (fiscal_year_id)`,

    // ---------- SYNCHRO, AUDIT, SAUVEGARDE, ALERTES ----------
    `CREATE TABLE sync_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('LAN', 'RELAY')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      items_sent INTEGER NOT NULL DEFAULT 0,
      items_received INTEGER NOT NULL DEFAULT 0,
      result TEXT CHECK (result IS NULL OR result IN ('SUCCESS', 'PARTIAL', 'FAILED')),
      error_message TEXT
    )`,

    // File d'envoi employé → boss, et copie de secours chiffrée (payload lisible par le boss seul).
    `CREATE TABLE change_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      device_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'CANCEL')),
      version INTEGER NOT NULL,
      payload BLOB NOT NULL,
      created_at TEXT NOT NULL,
      acked_at TEXT,
      purge_after TEXT
    )`,
    `CREATE INDEX change_log_pending ON change_log (created_at) WHERE acked_at IS NULL`,
    `CREATE INDEX change_log_purge ON change_log (purge_after) WHERE purge_after IS NOT NULL`,

    // Curseur de synchro de l'appareil (une ligne). Boss : dernier seq attribué ; employé : dernier seq reçu.
    `CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
      updated_at TEXT NOT NULL
    )`,

    `CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      actor_id TEXT NOT NULL,
      on_behalf_of_id TEXT,
      device_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id)`,
    `CREATE INDEX audit_log_date ON audit_log (created_at)`,

    `CREATE TABLE backup (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      destination TEXT NOT NULL CHECK (destination IN ('GOOGLE_DRIVE', 'ICLOUD', 'LOCAL_FILE')),
      ${bool('is_automatic', 0)},
      status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
      size_bytes INTEGER,
      file_reference TEXT,
      created_at TEXT NOT NULL
    )`,

    `CREATE TABLE alert (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES company (id) ${FK},
      type TEXT NOT NULL CHECK (type IN ('LOW_STOCK', 'NEGATIVE_STOCK', 'STALE_SYNC', 'CANCELLED_SALE')),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT
    )`,
    `CREATE INDEX alert_unread ON alert (created_at) WHERE read_at IS NULL`,

    // Index de synchro : le boss envoie les lignes dont seq > curseur de l'employé.
    ...['company', 'user', 'device', 'fiscal_year', 'category', 'item', 'customer', 'payment_method'].map(
      (t) => `CREATE INDEX ${t}_seq ON ${t} (seq)`,
    ),
  ],
};
