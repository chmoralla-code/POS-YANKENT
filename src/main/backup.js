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

const SCHEMA_VERSION = 2;
const LEGACY_TABLES = [
  'users', 'categories', 'products', 'product_units', 'customers',
  'sales', 'sale_items', 'refunds', 'stock_movements', 'settings',
];
const LOAN_TABLES = ['loans', 'loan_payments', 'loan_events', 'loan_reminders'];
const TABLES = [
  'users', 'categories', 'products', 'product_units', 'customers',
  'sales', 'sale_items', 'refunds', 'stock_movements',
  ...LOAN_TABLES,
  'settings',
];
// Tables that use AUTOINCREMENT (and therefore have a sqlite_sequence row).
const SEQ_TABLES = TABLES.filter((table) => table !== 'settings');
// Wipe order: children first. The sql.js shim does not enforce every foreign
// key path, but explicit ordering keeps restore behavior correct if it does.
const WIPE_ORDER = [
  'loan_reminders', 'loan_events', 'loan_payments', 'loans',
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
    for (const table of LOAN_TABLES) {
      if (!Array.isArray(data.tables[table])) throw new Error(`Backup missing table: ${table}`);
    }
  }
  return version;
}

/** Restore the database from a backup object. Idempotent & transactional. */
function importAll(db, data) {
  validateBackup(data);
  assertLoanReminderRunIdle('restore a backup');
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    for (const table of WIPE_ORDER) db.exec(`DELETE FROM ${table};`);
    const delSeq = db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${SEQ_TABLES.map(() => '?').join(',')})`);
    delSeq.run(...SEQ_TABLES);

    for (const table of TABLES) {
      // Schema-v1 backups legitimately have no Loan tables.
      const rows = Array.isArray(data.tables[table]) ? data.tables[table] : [];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
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

    // Keep restore, legacy migration, and aggregate reconciliation in one
    // transaction. Any validation/migration failure therefore rolls the
    // destructive wipe back to the exact pre-import database.
    preserveImportedCreditDifferences(db, { transactional: false });
  });
  try {
    tx();
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
