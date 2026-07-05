'use strict';
/* Tests: receipt building + ESC/POS encoding (print path). */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const { buildReceipt, receiptPlainText } = require('../src/main/lib/receipt');
const { encodeReceipt } = require('../src/main/lib/escpos');

async function setup() {
  const api = await makeApi();
  const cashier = api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  return { api, cashierSession: createSession(cashier) };
}

async function makeSale(api, session, items) {
  return api.call('pos:sales:create', session, {
    items,
    paymentMethod: 'cash',
    amountTendered: 99999,
  });
}

test('buildReceipt returns a complete receipt object with items + totals', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const res = await makeSale(api, cashierSession, [
    { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 2, unitPrice: 280, factor: 1 },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  assert.ok(receipt);
  assert.equal(receipt.txnId, res.txnId);
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].name, 'Portland Cement 40kg');
  assert.equal(receipt.items[0].qty, 2);
  assert.equal(receipt.items[0].isService, false);
  assert.equal(receipt.total, 627.2); // 560 net + 12% VAT = 627.20
  assert.equal(receipt.paymentMethod, 'cash');
  assert.ok(receipt.storeName);
  assert.ok(receipt.symbol);
  t.api.close();
});

test('buildReceipt returns null for a non-existent sale', async () => {
  const t = await setup();
  const { api } = t;
  const receipt = buildReceipt(api.db, 999999);
  assert.equal(receipt, null);
  t.api.close();
});

test('receiptPlainText produces a readable text receipt with key sections', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const res = await makeSale(api, cashierSession, [
    { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  const text = receiptPlainText(receipt, 32);
  assert.ok(text.includes('YANKENT POS'));
  assert.ok(text.includes(res.txnId));
  // Product name is truncated to fit 32 cols — the ASCII "..." ellipsis
  // (3 chars) means "Portland Cement 40kg" truncated to 8 chars becomes
  // "Portl..." (5 + 3), so check the surviving prefix.
  assert.ok(text.includes('Portl'));
  assert.ok(text.includes('TOTAL'));
  assert.ok(text.includes('Cash'));
  assert.ok(text.includes('Change'));
  t.api.close();
});

test('encodeReceipt produces non-empty bytes with init command', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const res = await makeSale(api, cashierSession, [
    { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  const bytes = encodeReceipt(receipt, 32);
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.length > 10);
  // First two bytes: ESC @ (init)
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  t.api.close();
});

test('receipt handles a service line without crashing', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  const cut = api.db.prepare('SELECT * FROM products WHERE sku=?').get('SVC-CUT');
  const res = await makeSale(api, cashierSession, [
    { productId: cut.id, sku: cut.sku, name: cut.name, unit: 'per cut', qty: 2, unitPrice: 25, factor: 1, isService: true },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  assert.equal(receipt.items[0].isService, true);
  const text = receiptPlainText(receipt, 32);
  // Service name "Wood Cutting Service" is long; check the prefix survives truncation.
  assert.ok(text.includes('Wood'));
  const bytes = encodeReceipt(receipt, 32);
  assert.ok(bytes.length > 10);
  t.api.close();
});

// Regression: long item names + large peso amounts must not overflow the
// configured paper width and wrap mid-number.  The peso sign (U+20B1) and
// Unicode ellipsis (U+2026) both expand when rendered by the thermal
// printer, which previously made padLine/row under-count and emit lines
// wider than `width`, causing prices to spill onto a second line.
// This test decodes the ESC/POS bytes back to text and asserts no line
// exceeds the width, for BOTH print paths (plain text + ESC/POS bytes).
function decodeEscposText(buf) {
  // Extract the printable latin1 text from an ESC/POS buffer: drop ESC/GS
  // command sequences (and their argument bytes) so only the human-readable
  // payload remains, then split into lines on LF.
  const lines = [];
  let cur = '';
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x1b || b === 0x1d) {
      const cmd = buf[i + 1];
      i += 2;
      if (cmd === 0x40) continue;             // ESC @ — no arg
      if (cmd === 0x56) { i += 1; continue; } // GS V m — 1 arg
      i += 1;                                  // all others — 1 arg
      continue;
    }
    if (b === 0x0a) { lines.push(cur); cur = ''; i++; continue; }
    cur += String.fromCharCode(b);
    i++;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

test('no line exceeds width when item names are long and amounts are large (regression)', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  // Long product names + large peso amounts that previously overflowed:
  //   "Alpha Zinc Roofing Sheet Premium Gauge 24" (truncated) + qty 5 @ 1000
  //   -> amount 5000 -> formatMoney "PHP 5,000.00" (12 chars).
  // The peso sign is 1 char in JS but renders as "PHP " (4) on the printer,
  // which is exactly the expansion that used to push ".00" to a new line.
  const res = await makeSale(api, cashierSession, [
    { productId: cement.id, sku: cement.sku, name: 'Alpha Zinc Roofing Sheet Premium Gauge 24', unit: 'sheet', qty: 5, unitPrice: 1000, factor: 1 },
    { productId: cement.id, sku: cement.sku, name: 'ABC Tile Adhesive Premium 25kg Bag', unit: 'bag', qty: 4, unitPrice: 400, factor: 1 },
    { productId: cement.id, sku: cement.sku, name: '3M Electrical Tape Professional Grade', unit: 'roll', qty: 7, unitPrice: 35, factor: 1 },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  const width = 32;

  // 1. Plain-text path (system print fallback).
  const text = receiptPlainText(receipt, width);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= width,
      `plain-text line overflowed width ${width}: "${line}" (${line.length} chars)`);
  }

  // 2. ESC/POS path (Bluetooth).  Decode bytes back to text and check.
  const bytes = encodeReceipt(receipt, width);
  const decoded = decodeEscposText(bytes);
  for (const line of decoded) {
    assert.ok(line.length <= width,
      `escpos line overflowed width ${width}: "${line}" (${line.length} chars)`);
  }

  // Sanity: the large amount and the peso-symbol expansion should be
  // visible in the decoded bytes as "PHP 5,000.00" on a single line,
  // not split across lines.
  assert.ok(decoded.some((l) => l.includes('PHP 5,000.00')),
    'expected "PHP 5,000.00" on one line; got:\n' + decoded.join('\n'));

  t.api.close();
});

test('currency symbol is sanitized to ASCII "PHP " in the receipt object', async () => {
  // The default currency_symbol setting is the peso sign (U+20B1).
  // buildReceipt must expand it to "PHP " so formatMoney's output length
  // matches what the printer renders (4 chars, not 1).
  const t = await setup();
  const { api, cashierSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const res = await makeSale(api, cashierSession, [
    { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 },
  ]);
  const receipt = buildReceipt(api.db, res.saleId);
  assert.equal(receipt.symbol, 'PHP ');
  assert.ok(!receipt.symbol.includes('\u20b1'));
  t.api.close();
});