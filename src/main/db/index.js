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
  return db;
}

/**
 * Settings helper — read/write the key/value settings table.
 */
const SETTINGS_DEFAULTS = {
  store_name: 'YANKENT POS',
  store_address: '123 Maharlika Hwy, Cabanatuan City',
  store_tin: '123-456-789-000',
  store_phone: '',
  vat_rate: '12',            // percent, inclusive
  currency: 'PHP',
  currency_symbol: '₱',
  receipt_footer: "Thank you for your business!\nKeep receipt for returns (7 days).",
  receipt_width: '32',       // 32 or 48 chars for ESC/POS
  // thermal printer
  printer_type: 'bluetooth', // 'bluetooth' | 'none'
  printer_service_uuid: '000018f0-0000-1000-8000-00805f9b34fb',
  printer_char_uuid: '00002af1-0000-1000-8000-00805f9b34fb',
  printer_device_name: '',
  printer_auto_print: '1',
  // telegram (never hardcoded — admin enters at runtime)
  telegram_token: '',
  telegram_chat_id: '',
  telegram_enabled: '0',
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
