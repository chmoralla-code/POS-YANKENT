'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, ensureSettings } = require('../src/main/db');
const {
  _resolveWindowsPrinter: resolveWindowsPrinter,
  _buildWindowsPrinterHealth: buildWindowsPrinterHealth,
  _autoRecoverWindowsPrinter: autoRecoverWindowsPrinter,
} = require('../src/main/ipc/integrations');

test('stale POS-58 queue is replaced by its only connected sibling', () => {
  const result = resolveWindowsPrinter([
    { name: 'POS-58', port: 'USB002', driver: 'POS-58 11.3.0.1', connected: false, isDefault: true },
    { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58 11.3.0.1', connected: true, isDefault: false },
    { name: 'Brother DCP-T420W Printer', port: 'WSD-1', driver: 'Brother', connected: null, isDefault: false },
  ], 'POS-58');

  assert.equal(result.selected.name, 'POS-58 (1)');
  assert.equal(result.selected.port, 'USB003');
  assert.equal(result.autoSelected, true);
  assert.equal(result.code, 'replacement');
});

test('an exact connected queue is never replaced', () => {
  const result = resolveWindowsPrinter([
    { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: true },
    { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58', connected: true },
  ], 'POS-58');

  assert.equal(result.selected.name, 'POS-58');
  assert.equal(result.autoSelected, false);
  assert.equal(result.code, 'configured');
});

test('an installed non-USB queue remains usable when physical state is unknown', () => {
  const result = resolveWindowsPrinter([
    { name: 'Bluetooth Receipt Printer', port: 'BTH001', driver: 'Generic', connected: null },
  ], 'Bluetooth Receipt Printer');

  assert.equal(result.selected.name, 'Bluetooth Receipt Printer');
  assert.equal(result.autoSelected, false);
});

test('a disconnected queue reports a useful error when replacement is ambiguous', () => {
  const result = resolveWindowsPrinter([
    { name: 'POS-58', port: 'USB001', driver: 'POS-58', connected: false },
    { name: 'POS-58 (1)', port: 'USB002', driver: 'POS-58', connected: true },
    { name: 'POS-58 (2)', port: 'USB003', driver: 'POS-58', connected: true },
  ], 'POS-58');

  assert.equal(result.selected, null);
  assert.equal(result.code, 'disconnected');
  assert.match(result.error, /not physically connected/i);
});
test('automatic recovery does not guess when the only connected thermal printer is a different model', () => {
  const result = resolveWindowsPrinter([
    { name: 'POS-58', port: 'USB001', driver: 'POS-58', connected: false },
    { name: 'XP-Q200', port: 'USB004', driver: 'Thermal Receipt Printer', connected: true },
  ], 'POS-58');

  assert.equal(result.selected, null);
  assert.equal(result.autoSelected, false);
  assert.equal(result.code, 'disconnected');
});

test('a similarly named connected non-thermal queue is never selected for recovery', () => {
  const result = resolveWindowsPrinter([
    { name: 'Office Printer', port: 'USB001', driver: 'Office Laser', connected: false },
    { name: 'Office Printer (1)', port: 'USB002', driver: 'Office Laser', connected: true },
  ], 'Office Printer');

  assert.equal(result.selected, null);
  assert.equal(result.autoSelected, false);
});
test('PostScript office printers are not treated as thermal receipt printers', () => {
  const health = buildWindowsPrinterHealth([
    { name: 'Office PostScript Printer', port: 'USB009', driver: 'Generic PostScript', connected: true },
  ], 'POS-58');

  assert.equal(health.connectedThermalPrinters.length, 0);
  assert.equal(health.canAutoRecover, false);
});


test('printer health requires an explicit choice when two thermal printers are connected', () => {
  const health = buildWindowsPrinterHealth([
    { name: 'POS-58', port: 'USB001', driver: 'POS-58', connected: false },
    { name: 'POS-58 (1)', port: 'USB002', driver: 'POS-58', connected: true },
    { name: 'POS-58 (2)', port: 'USB003', driver: 'POS-58', connected: true },
  ], 'POS-58');

  assert.equal(health.status, 'needs-selection');
  assert.equal(health.needsSelection, true);
  assert.equal(health.canAutoRecover, false);
  assert.equal(health.selected, null);
});

test('printer health marks one connected replacement as safely recoverable', () => {
  const health = buildWindowsPrinterHealth([
    { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: false },
    { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58', connected: true },
  ], 'POS-58');

  assert.equal(health.status, 'repair-available');
  assert.equal(health.canAutoRecover, true);
  assert.equal(health.selected.name, 'POS-58 (1)');
});

test('automatic recovery persists only the discovered printer and system mode', async () => {
  const values = new Map([
    ['startup_test_printer', 'POS-58'],
    ['printer_type', 'bluetooth'],
  ]);
  const writes = [];
  const ctx = {
    db: {},
    getSetting: (_db, key) => values.get(key) || '',
    setSetting: (_db, key, value) => {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
  const fixture = [
    { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: false },
    { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58', connected: true },
  ];

  const result = await autoRecoverWindowsPrinter(ctx, async () => fixture);

  assert.equal(result.repaired, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.selected.name, 'POS-58 (1)');
  assert.deepEqual(writes, [
    ['startup_test_printer', 'POS-58 (1)'],
    ['printer_type', 'system'],
  ]);
});

test('automatic recovery makes no changes when the configured printer is ready', async () => {
  const writes = [];
  const ctx = {
    db: {},
    getSetting: (_db, key) => key === 'startup_test_printer' ? 'POS-58' : 'system',
    setSetting: (_db, key, value) => writes.push([key, value]),
  };

  const result = await autoRecoverWindowsPrinter(ctx, async () => [
    { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: true },
  ]);

  assert.equal(result.repaired, false);
  assert.equal(result.status, 'ready');
  assert.deepEqual(writes, []);
});
test('automatic recovery preserves disabled printing and a configured Bluetooth printer', async () => {
  const fixture = [
    { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: false },
    { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58', connected: true },
  ];
  const cases = [
    { type: 'none', device: '', status: 'disabled' },
    { type: 'bluetooth', device: 'My Bluetooth Printer', status: 'bluetooth-configured' },
  ];

  for (const entry of cases) {
    const values = new Map([
      ['startup_test_printer', 'POS-58'],
      ['printer_type', entry.type],
      ['printer_device_name', entry.device],
    ]);
    const writes = [];
    const ctx = {
      db: {},
      getSetting: (_db, key) => values.get(key) || '',
      setSetting: (_db, key, value) => writes.push([key, value]),
    };

    const result = await autoRecoverWindowsPrinter(ctx, async () => fixture);

    assert.equal(result.repaired, false);
    assert.equal(result.status, entry.status);
    assert.equal(result.canAutoRecover, false);
    assert.deepEqual(writes, []);
  }
});



test('ensureSettings adds new defaults without overwriting an existing installation', async () => {
  const dbPath = path.join(os.tmpdir(), 'yankent-printer-settings-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.sqlite');
  const db = await openDatabase(dbPath);
  try {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('store_name', 'My Existing Store');
    ensureSettings(db);

    assert.equal(db.prepare("SELECT value FROM settings WHERE key='store_name'").get().value, 'My Existing Store');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='startup_test_printer'").get().value, 'POS-58');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='startup_test_print'").get().value, '1');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='printer_auto_print'").get().value, '1');
  } finally {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
  }
});
