'use strict';
/* Tests: Telegram sales-report message building (offline-safe, pure DB). */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const { buildReportMessage, buildAnalytics, escapeHtml } = require('../src/main/lib/telegram');

async function setup() {
  const api = await makeApi();
  const cashier = api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  return { api, cashierSession: createSession(cashier) };
}

async function makeSale(api, session, total, method = 'cash') {
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  // price 280/bag; pick qty to approximate total
  const qty = Math.max(1, Math.round(total / 280));
  const res = await api.call('pos:sales:create', session, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty, unitPrice: 280, factor: 1 }],
    paymentMethod: method, amountTendered: method === 'cash' ? 99999 : 0,
  });
  // Commit the sale so it's completed (analytics/reports filter on
  // status='completed' — pending sales aren't counted until PRINT is clicked).
  await api.call('pos:sales:commit', session, res.txnId);
  return res;
}

test('buildReportMessage includes header, today/yesterday/month/year, and footer', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  await makeSale(api, cashierSession, 560);
  const msg = buildReportMessage(api.db);
  assert.ok(msg.includes('YANKENT POS Sales Report'));
  assert.ok(msg.includes('VAT included:'), 'report uses the VAT stored on each sale');
  assert.ok(msg.includes('Today:'));
  assert.ok(msg.includes('Yesterday:'));
  assert.ok(msg.includes('This Month:'));
  assert.ok(msg.includes('This Year:'));
  assert.ok(msg.includes('Best Day:'));
  assert.ok(msg.includes('Sent from YANKENT POS'));
  t.api.close();
});

test('buildReportMessage works with zero sales (no crash, still has structure)', async () => {
  const t = await setup();
  const { api } = t;
  const msg = buildReportMessage(api.db);
  assert.ok(msg.includes('YANKENT POS Sales Report'));
  assert.ok(msg.includes('Today:'));
  // amounts should be ₱0 with 0 transactions
  assert.ok(/Today:.*0 transactions/.test(msg));
  t.api.close();
});

test('buildAnalytics returns today + payment breakdown + top products', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  await makeSale(api, cashierSession, 560, 'cash');
  await makeSale(api, cashierSession, 280, 'card');
  const a = buildAnalytics(api.db);
  assert.ok(a.today);
  assert.ok(a.today.tx >= 2);
  assert.ok(a.payBreak && a.payBreak.length >= 2);
  const methods = a.payBreak.map((p) => p.payment_method);
  assert.ok(methods.includes('cash'));
  assert.ok(methods.includes('card'));
  assert.ok(Array.isArray(a.topProducts));
  assert.ok(a.topProducts.length > 0);
  assert.equal(a.topProducts[0].name, 'Portland Cement 40kg');
  t.api.close();
});

test('buildAnalytics handles an empty database gracefully', async () => {
  const t = await setup();
  const { api } = t;
  const a = buildAnalytics(api.db);
  assert.equal(a.today.tx, 0);
  assert.equal(a.today.total, 0);
  assert.equal(a.avgTx, 0);
  assert.equal(a.itemsSold, 0);
  assert.equal(a.topProducts.length, 0);
  t.api.close();
});

test('escapeHtml escapes <, >, & in user-supplied text', () => {
  assert.equal(escapeHtml('Nails & Screws'), 'Nails &amp; Screws');
  assert.equal(escapeHtml('Angle < 90°'), 'Angle &lt; 90°');
  assert.equal(escapeHtml('3/4" > Standard'), '3/4" &gt; Standard');
  assert.equal(escapeHtml('Plain Name'), 'Plain Name');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  // Chained: & must be escaped first so < becomes &lt; not &amp;lt;
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test('fresh installations do not ship Telegram credentials', async () => {
  const t = await setup();
  assert.equal(
    t.api.db.prepare("SELECT value FROM settings WHERE key='telegram_token'").get().value,
    ''
  );
  assert.equal(
    t.api.db.prepare("SELECT value FROM settings WHERE key='telegram_chat_id'").get().value,
    ''
  );
  assert.equal(
    t.api.db.prepare("SELECT value FROM settings WHERE key='telegram_enabled'").get().value,
    '0'
  );
  t.api.close();
});

test('buildReportMessage HTML-escapes product and cashier names (no Telegram parse failure)', async () => {
  // Regression: product/cashier names with <, >, & broke Telegram's HTML
  // parse mode — the message was rejected with "can't parse entities" and,
  // because the preload envelope bug hid the error, the UI showed
  // "Report sent ✓" even though nothing arrived.
  const t = await setup();
  const { api, cashierSession } = t;
  // Insert a product with HTML-special characters in its name, then sell it
  // so it shows up in today's top products.
  const prod = api.db.prepare(
    `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
     VALUES(?,?,?,?,?,?,?,?,?,1)`
  ).run('TEST-HTML', 'Nails & Screws < Premium', null, 'kg', 100, 0, 50, 10, 0);
  api.db.prepare('INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)')
    .run(prod.lastInsertRowid, 'kg', 1, 50);
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: prod.lastInsertRowid, sku: 'TEST-HTML', name: 'Nails & Screws < Premium', unit: 'kg', qty: 2, unitPrice: 50, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 9999,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);

  const msg = buildReportMessage(api.db);

  // The product name MUST be escaped — no raw < or & in the message.
  assert.ok(!msg.includes('Nails & Screws < Premium'),
    'raw unescaped product name must not appear in the Telegram message');
  assert.ok(msg.includes('Nails &amp; Screws &lt; Premium'),
    'product name must be HTML-escaped in the message');
  // Sanity: the message still has structure.
  assert.ok(msg.includes('YANKENT POS Sales Report'));
  t.api.close();
});

test('sendReport handler returns { ok:false, error } on failure (not hidden behind guard envelope)', async () => {
  // Regression: the preload's sendReport returned the raw guard envelope
  // ({ ok:true, data:{ ok:false, error } }), so callers checked the OUTER
  // ok (always true) and showed "Report sent ✓" even on failure.  The
  // handler must return a shape the preload can unwrap to surface errors.
  const t = await setup();
  const { api, cashierSession } = t;
  // Force a failure: clear the telegram token so the handler returns
  // { ok: false, error: 'Telegram not configured' }.
  api.db.prepare("UPDATE settings SET value='' WHERE key='telegram_token'").run();

  // The IPC harness calls the handler directly (bypassing the preload), so
  // we exercise the handler's return shape, then simulate the preload's
  // unwrapping logic to confirm the error is reachable.
  const fn = api._handler('pos:telegram:sendReport');
  const envelope = await fn({}, cashierSession.token);
  // Guard wraps as { ok:true, data:{ ok:false, error } } on returned failure.
  assert.ok(envelope.ok === true, 'guard outer ok is true on returned failure');
  assert.ok(envelope.data && envelope.data.ok === false, 'inner ok is false');
  assert.ok(envelope.data.error, 'inner error message is present');
  // Preload unwrapping: returns envelope.data, so callers see the real ok.
  const unwrapped = envelope.data;
  assert.equal(unwrapped.ok, false);
  assert.ok(unwrapped.error);
  t.api.close();
});
