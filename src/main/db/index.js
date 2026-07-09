'use strict';

const path = require('path');
const fs = require('fs');
const { openShim } = require('./shim');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Open (or create) the YANKENT POS SQLite database and apply the schema.
 * @param {string} dbPath - absolute path to the .sqlite file
 * @returns {Promise<import('./shim').Database>}
 */
async function openDatabase(dbPath) {
  const db = await openShim(dbPath);

  // sql.js (in-memory) ignores WAL; strip PRAGMA statements before applying.
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
    .split('\n').filter((l) => !/^\s*PRAGMA/i.test(l)).join('\n');
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * Lightweight migrations for existing databases created by older versions
 * of the app.  The schema.sql uses CREATE TABLE IF NOT EXISTS so new tables
 * are added on fresh installs, but existing tables keep their OLD constraints.
 * We check for known gaps and patch them here.
 */
function migrate(db) {
  // ---- stock_movements: add 'refund' to the CHECK constraint ------------
  // Older databases (pre-refund-feature) had CHECK(movement IN
  // ('sale','restock','adjustment')) — missing 'refund'.  SQLite can't
  // ALTER a CHECK constraint, so we recreate the table with the correct
  // constraint and copy data over.  Safe because the table structure is
  // identical except for the constraint.
  const smSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='stock_movements'").get();
  if (smSchema && smSchema.sql && !smSchema.sql.includes("'refund'")) {
    db.exec('ALTER TABLE stock_movements RENAME TO stock_movements_old');
    db.exec(`CREATE TABLE stock_movements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      movement    TEXT NOT NULL CHECK (movement IN ('sale','restock','adjustment','refund')),
      qty_change  REAL NOT NULL,
      reason      TEXT,
      user_id     INTEGER REFERENCES users(id),
      datetime    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec('INSERT INTO stock_movements SELECT * FROM stock_movements_old');
    db.exec('DROP TABLE stock_movements_old');
  }

  // ---- stock_movements: add source_location column ---------------------
  // Older databases (pre-location-feature) had no source_location column.
  // SQLite ALTER TABLE ADD COLUMN is safe here — no constraint changes.
  const smCols = db.prepare("PRAGMA table_info(stock_movements)").all();
  if (!smCols.find((c) => c.name === 'source_location')) {
    db.exec('ALTER TABLE stock_movements ADD COLUMN source_location TEXT');
  }

  // ---- Store info: clear stale defaults on existing databases ----------
  // The bundled DB and fresh-install defaults use "YANKENT POS" + the
  // full Tagbilaran address, with an empty TIN.  Older installs may still
  // carry a TIN or a different address.  Overwrite the three keys if the
  // existing values look like the old canned placeholders.  Always leave
  // a real admin-typed value alone.
  const upd = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const cur = db.prepare("SELECT value FROM settings WHERE key='store_tin'").get();
  // Only clear TIN if it matches the old canned placeholder ('123-456-789-000').
  if (cur && cur.value === '123-456-789-000') upd.run('store_tin', '');
  const sn = db.prepare("SELECT value FROM settings WHERE key='store_name'").get();
  if (sn && (sn.value === 'YANKENT POS / YANKENT HARDWARE CONSTRUCTION' || sn.value === '123 Maharlika Hwy, Cabanatuan City')) {
    upd.run('store_name', 'YANKENT POS');
  }
  const sa = db.prepare("SELECT value FROM settings WHERE key='store_address'").get();
  if (sa && sa.value === '123 Maharlika Hwy, Cabanatuan City') {
    upd.run('store_address', 'YANKENT HARDWARE / CONSTRUCTION Tagbilaran North Road, Cortez, 6300 Bohol');
  }
}

/**
 * Settings helper — read/write the key/value settings table.
 */
const SETTINGS_DEFAULTS = {
  store_name: 'YANKENT POS',
  store_address: 'YANKENT HARDWARE / CONSTRUCTION Tagbilaran North Road, Cortez, 6300 Bohol',
  store_tin: '',
  store_phone: '',
  vat_rate: '12',            // percent, inclusive
  currency: 'PHP',
  currency_symbol: '₱',
  receipt_footer: "Thank you for your business!\nKeep receipt for returns (7 days).",
  receipt_width: '32',       // 32 or 48 chars for ESC/POS
  discount_percent: '0',     // admin-set discount % available to cashiers
  // thermal printer
  printer_type: 'bluetooth', // 'bluetooth' | 'none'
  printer_service_uuid: '000018f0-0000-1000-8000-00805f9b34fb',
  printer_char_uuid: '00002af1-0000-1000-8000-00805f9b34fb',
  printer_device_name: '',
  printer_auto_print: '1',
  // Auto test-print on startup: sends a short ESC/POS test to the Windows
  // printer named below the first time the POS opens after the laptop is
  // powered on, so the cashier knows the printer is ready before the first
  // sale.  '1' = enabled (default), '0' = disabled.
  startup_test_print: '1',
  startup_test_printer: 'POS-58',
  // telegram (defaults shipped with the installer so the owner's bot is
  // pre-configured on every fresh install; admin can change in Settings)
  telegram_token: '8888024178:AAHEtknhc05MJzP1d0kCGXoEXpV0xXhJCaE',
  telegram_chat_id: '5161011730',
  telegram_enabled: '0',
  app_version: '1',
  session_idle_timeout: '15', // minutes; 0 = disabled (not recommended)
};

function ensureSettings(db) {
  const has = db.prepare('SELECT COUNT(*) AS c FROM settings').get();
  if (!has.c) {
    const ins = db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) ins.run(k, v);
    });
    tx(Object.entries(SETTINGS_DEFAULTS));
  }
  return SETTINGS_DEFAULTS;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, String(value));
}

function getAllSettings(db) {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = {
  openDatabase,
  ensureSettings,
  getSetting,
  setSetting,
  getAllSettings,
  SETTINGS_DEFAULTS,
};
