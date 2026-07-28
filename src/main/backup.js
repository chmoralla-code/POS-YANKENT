'use strict';

/**
 * Backup & import for the local POS database.
 *
 * Backup  = single JSON object containing every table's rows.
 * Import  = wipe local tables and restore from a backup object (preserves ids).
 *
 * Used by Admin → Settings → Backup / Import so the owner can recover
 * everything on a new laptop.
 */

const { preserveImportedCreditDifferences } = require('./lib/loans');
const { assertLoanReminderRunIdle } = require('./lib/loan-reminders');

const SCHEMA_VERSION = 4;
const LEGACY_TABLES = [
  'users', 'categories', 'products', 'product_units', 'customers',
  'sales', 'sale_items', 'refunds', 'stock_movements', 'settings',
];
const LOAN_TABLES_V2 = ['loans', 'loan_payments', 'loan_events', 'loan_reminders'];
const LOAN_TABLES = [...LOAN_TABLES_V2, 'loan_email_reminders'];
const TABLES = [
  'users', 'categories', 'products', 'product_units', 'customers',
  'sales', 'sale_items', 'refunds', 'stock_movements',
  ...LOAN_TABLES,
  'settings',
];
// Tables that use AUTOINCREMENT (and therefore have a sqlite_sequence row).
const SEQ_TABLES = TABLES.filter((table) => table !== 'settings');
// Wipe order: children first so restore remains valid with foreign-key
// enforcement enabled during all normal database work.
const WIPE_ORDER = [
  'loan_email_reminders', 'loan_reminders', 'loan_events', 'loan_payments', 'loans',
  'sale_items', 'stock_movements', 'refunds', 'sales', 'product_units',
  'products', 'customers', 'categories', 'users', 'settings',
];

/** Export the entire database to a plain JS object (JSON-serializable). */
function exportAll(db) {
  const out = {
    app: 'YANKENT POS',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables: {},
  };
  for (const table of TABLES) out.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  // API credentials are machine-local secrets. Backups preserve the setting
  // key but require the administrator to re-enter its value after restore.
  out.tables.settings = out.tables.settings.map((row) =>
    row.key === 'resend_api_key' ? { ...row, value: '' } : row
  );
  return out;
}

function validateBackup(data) {
  if (!data || !data.tables || typeof data.tables !== 'object') throw new Error('Invalid backup file');
  const version = Number(data.schemaVersion || 1);
  if (!Number.isInteger(version) || version < 1) throw new Error('Invalid backup schema version');
  if (version > SCHEMA_VERSION) {
    throw new Error(`Backup schema version ${version} is newer than this app supports (maximum ${SCHEMA_VERSION})`);
  }
  // The original v1 tables are always required. Loan tables are optional only
  // for old backups; current backups must be complete so corruption is not
  // mistaken for backward compatibility.
  for (const table of LEGACY_TABLES) {
    if (!Array.isArray(data.tables[table])) throw new Error(`Backup missing table: ${table}`);
  }
  if (version >= 2) {
    for (const table of LOAN_TABLES_V2) {
      if (!Array.isArray(data.tables[table])) throw new Error(`Backup missing table: ${table}`);
    }
  }
  if (version >= 3 && !Array.isArray(data.tables.loan_email_reminders)) {
    throw new Error('Backup missing table: loan_email_reminders');
  }
  if (version >= 4 && data.tables.products.some((row) =>
    !row || !Object.prototype.hasOwnProperty.call(row, 'purchase_source')
  )) {
    throw new Error('Backup products are missing purchase_source');
  }
  return version;
}

/** Restore the database from a backup object. Idempotent & transactional. */
function importAll(db, data) {
  validateBackup(data);
  assertLoanReminderRunIdle('restore a backup');

  // Build every insert plan from the trusted local schema before deleting a
  // single row. Backup keys are data, never SQL identifiers: rejecting
  // unknown keys prevents malformed files from injecting SQL through column
  // names and avoids silently ignoring columns that appear after row one.
  const plans = {};
  for (const table of TABLES) {
    const rows = Array.isArray(data.tables[table]) ? data.tables[table] : [];
    const allowed = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const allowedSet = new Set(allowed);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Backup table ${table} contains an invalid row`);
      }
      for (const key of Object.keys(row)) {
        if (!allowedSet.has(key)) throw new Error(`Backup table ${table} contains an unknown column: ${key}`);
      }
    }
    const cols = allowed.filter((column) =>
      rows.some((row) => Object.prototype.hasOwnProperty.call(row, column))
    );
    plans[table] = { rows, cols };
  }

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    for (const table of WIPE_ORDER) db.exec(`DELETE FROM ${table};`);
    const delSeq = db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${SEQ_TABLES.map(() => '?').join(',')})`);
    delSeq.run(...SEQ_TABLES);

    for (const table of TABLES) {
      // Schema-v1 backups legitimately have no Loan tables.
      const { rows, cols } = plans[table];
      if (!rows.length) continue;
      if (!cols.length) continue;
      const stmt = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      );
      let maxId = 0;
      for (const row of rows) {
        stmt.run(...cols.map((key) => (row[key] === undefined ? null : row[key])));
        if (row.id != null) {
          const numericId = Number(row.id);
          if (numericId > maxId) maxId = numericId;
        }
      }
      if (table !== 'settings' && maxId > 0) {
        db.prepare('INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(table, maxId);
      }
    }

    // Old backups can contain the customer examples shipped by the original
    // release. Remove untouched examples before preserving imported balances;
    // restored client-created profiles and any real account activity remain.
    const { removeLegacyDemoCustomers } = require('./db/seed');
    removeLegacyDemoCustomers(db, { transactional: false, snapshot: false });

    // Keep restore, legacy migration, and aggregate reconciliation in one
    // transaction. Any validation/migration failure therefore rolls the
    // destructive wipe back to the exact pre-import database.
    preserveImportedCreditDifferences(db, { transactional: false });
  });
  try {
    tx();
    // Verify the restored database reached disk before reporting success.
    db.flush();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

module.exports = {
  exportAll,
  importAll,
  SCHEMA_VERSION,
  TABLES,
  LEGACY_TABLES,
  LOAN_TABLES,
};
