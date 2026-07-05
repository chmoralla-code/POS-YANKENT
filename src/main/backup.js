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

const SCHEMA_VERSION = 1;
const TABLES = [
  'users', 'categories', 'products', 'product_units', 'customers',
  'sales', 'sale_items', 'refunds', 'stock_movements', 'settings',
];
// Tables that use AUTOINCREMENT (and therefore have a sqlite_sequence row).
const SEQ_TABLES = TABLES.filter((t) => t !== 'settings');
// Wipe order: children first so FK-off still keeps things tidy.
const WIPE_ORDER = [
  'sale_items', 'stock_movements', 'refunds', 'sales', 'product_units',
  'products', 'customers', 'categories', 'users', 'settings',
];

/** Export the entire database to a plain JS object (JSON-serializable). */
function exportAll(db) {
  const out = { app: 'YANKENT POS', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return out;
}

/** Restore the database from a backup object. Idempotent & transactional. */
function importAll(db, data) {
  if (!data || !data.tables) throw new Error('Invalid backup file');
  for (const t of TABLES) {
    if (!Array.isArray(data.tables[t])) throw new Error(`Backup missing table: ${t}`);
  }

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    for (const t of WIPE_ORDER) db.exec(`DELETE FROM ${t};`);
    const delSeq = db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${SEQ_TABLES.map(() => '?').join(',')})`);
    delSeq.run(...SEQ_TABLES);

    for (const t of TABLES) {
      const rows = data.tables[t];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(
        `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      );
      let maxId = 0;
      for (const r of rows) {
        stmt.run(...cols.map((k) => (r[k] === undefined ? null : r[k])));
        if (r.id != null) { const n = Number(r.id); if (n > maxId) maxId = n; }
      }
      if (t !== 'settings' && maxId > 0) {
        db.prepare('INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES (?, ?)').run(t, maxId);
      }
    }
  });
  try {
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

module.exports = { exportAll, importAll, SCHEMA_VERSION, TABLES };
