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
  // sql.js supports SQLite foreign keys, but unlike native SQLite wrappers it
  // does not enable them automatically. Turn enforcement on after migrations
  // (which rebuild a few legacy tables) so cascades and SET NULL guarantees
  // in schema.sql actually protect normal app writes.
  db.pragma('foreign_keys = ON');
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
    db.transaction(() => {
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)');
    })();
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

  // ---- Utang customer profiles + per-sale Loan ledger ------------------
  // Existing databases keep their original customers/sales table shape when
  // schema.sql runs CREATE TABLE IF NOT EXISTS. Add every new field
  // independently so interrupted upgrades are safe to retry.
  const addColumn = (table, column, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  addColumn('customers', 'entity_kind', "TEXT NOT NULL DEFAULT 'individual'");
  addColumn('customers', 'contact_person', 'TEXT');
  addColumn('customers', 'email', 'TEXT');
  addColumn('customers', 'address', 'TEXT');
  addColumn('customers', 'notes', 'TEXT');
  addColumn('customers', 'active', 'INTEGER NOT NULL DEFAULT 1');
  // SQLite does not permit a non-constant datetime() default in ALTER TABLE,
  // so older databases receive a nullable column and are backfilled here.
  addColumn('customers', 'updated_at', 'TEXT');
  db.exec("UPDATE customers SET updated_at=COALESCE(updated_at,created_at,datetime('now'))");
  addColumn('sales', 'due_date', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_credit_active ON customers(type,active,name)');

  // Early releases shipped example customer accounts. Remove only untouched
  // seed signatures before aggregate balances are converted into Loan rows;
  // genuine client activity causes the cleanup helper to preserve the row.
  const { removeLegacyDemoCustomers } = require('./seed');
  const demoCleanup = removeLegacyDemoCustomers(db);
  if (demoCleanup.snapshotError) {
    console.warn(`[db] Legacy demo customer cleanup skipped: ${demoCleanup.snapshotError}`);
  } else if (demoCleanup.persistenceError) {
    console.warn(`[db] Legacy demo customer cleanup was not durably saved: ${demoCleanup.persistenceError}`);
  } else if (demoCleanup.removed) {
    const backupNote = demoCleanup.backupPath ? ` Backup: ${demoCleanup.backupPath}` : '';
    console.log(`[db] Removed ${demoCleanup.removed} legacy demo customer account(s).${backupNote}`);
  }

  // ---- loan_reminders: terminal delivery-uncertain state ---------------
  // Graceful shutdown can begin after Telegram accepted a request but before
  // its response arrives. Preserve that ambiguity durably and never retry the
  // same Loan/day, which could otherwise send a duplicate reminder.
  const reminderSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='loan_reminders'").all()[0];
  if (reminderSchema && reminderSchema.sql && !reminderSchema.sql.includes("'uncertain'")) {
    db.transaction(() => {
      db.exec('ALTER TABLE loan_reminders RENAME TO loan_reminders_old');
      db.exec(`CREATE TABLE loan_reminders (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        loan_id             INTEGER NOT NULL REFERENCES loans(id),
        reminder_date       TEXT NOT NULL,
        state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed','uncertain')),
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        telegram_message_id TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at             TEXT,
        UNIQUE (loan_id, reminder_date)
      )`);
      db.exec(`INSERT INTO loan_reminders(
        id,loan_id,reminder_date,state,attempt_count,last_error,
        telegram_message_id,created_at,sent_at
      ) SELECT id,loan_id,reminder_date,state,attempt_count,last_error,
        telegram_message_id,created_at,sent_at FROM loan_reminders_old`);
      db.exec('DROP TABLE loan_reminders_old');
      db.exec('CREATE INDEX IF NOT EXISTS idx_loan_reminders_date_state ON loan_reminders(reminder_date,state)');
    })();
  }

  // Preserve aggregate credit from pre-Ledger installs without guessing a
  // due date. This helper is idempotent: it only creates an opening balance
  // when a customer has credit_used > 0 and no Loan row at all.
  const { migrateLegacyBalances } = require('../lib/loans');
  migrateLegacyBalances(db);
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
  // Default Telegram integration for this store's installer builds.
  // Fresh installs and blank upgrades get these; Settings can still override.
  telegram_token: '8888024178:AAHEtknhc05MJzP1d0kCGXoEXpV0xXhJCaE',
  telegram_chat_id: '5161011730',
  telegram_enabled: '1',
  // Owner-entered store expenses for the simple Analytics earnings card.
  // Earnings = this month's sales − this value (beginner-friendly, one blank).
  analytics_total_expenses: '0',
  app_version: '1',
  session_idle_timeout: '15', // minutes; 0 = disabled (not recommended)
};

function ensureSettings(db) {
  // Seed every missing key, not only an entirely empty settings table.
  // Existing installations predate newer settings (for example the selected
  // Windows receipt printer), so the old all-or-nothing check left those keys
  // absent forever and silently activated hard-coded fallbacks.
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) ins.run(k, v);
  });
  tx(Object.entries(SETTINGS_DEFAULTS));

  // Older installs may already have blank telegram_* rows, or a previous
  // store chat ID. Apply the current store defaults without wiping a custom
  // chat/token the owner typed in Settings.
  const token = getSetting(db, 'telegram_token');
  const chatId = String(getSetting(db, 'telegram_chat_id') || '');
  const legacyChatIds = new Set(['', '5144639792']);
  let appliedDefaults = false;
  if (!token) {
    setSetting(db, 'telegram_token', SETTINGS_DEFAULTS.telegram_token);
    appliedDefaults = true;
  }
  if (legacyChatIds.has(chatId)) {
    setSetting(db, 'telegram_chat_id', SETTINGS_DEFAULTS.telegram_chat_id);
    setSetting(db, 'telegram_token', SETTINGS_DEFAULTS.telegram_token);
    appliedDefaults = true;
  }
  if (appliedDefaults) {
    setSetting(db, 'telegram_enabled', SETTINGS_DEFAULTS.telegram_enabled);
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
