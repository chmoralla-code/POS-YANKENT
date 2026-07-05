'use strict';
/* Tests: History of Delivery feature (stock restock log).
 * Verifies that every time new stock is added to a product — via the
 * "Adjust Stock" modal (setStock with a higher value) or initial stock on
 * product creation — a row appears in the stock delivery history. */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');

async function setup() {
  const api = await makeApi();
  const { db } = api;
  const admin = db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const cement = db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const nails = db.prepare('SELECT * FROM products WHERE sku=?').get('NIL-2');
  return { api, admin, cashier, cement, nails,
    adminSession: createSession(admin), cashierSession: createSession(cashier) };
}

test('setStock with a higher value logs a positive delivery record', async () => {
  const t = await setup();
  const { api, cement, adminSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  // Restock: add 50 bags
  await api.call('pos:products:setStock', adminSession, cement.id, before + 50, 'New delivery from supplier');
  const list = await api.call('pos:reports:stockDeliveries', adminSession, {});
  const entry = list.find((r) => r.product_id === cement.id);
  assert.ok(entry, 'cement restock should appear in delivery history');
  assert.equal(entry.qty_change, 50);
  assert.equal(entry.reason, 'New delivery from supplier');
  assert.equal(entry.user_name, adminSession.full_name);
  t.api.close();
});

test('setStock with a lower value does NOT appear in delivery history', async () => {
  const t = await setup();
  const { api, cement, adminSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  // Stock count correction downward (loss) — should not be a "delivery"
  await api.call('pos:products:setStock', adminSession, cement.id, before - 10, 'Stock count loss');
  const list = await api.call('pos:reports:stockDeliveries', adminSession, {});
  const entry = list.find((r) => r.product_id === cement.id && r.reason === 'Stock count loss');
  assert.equal(entry, undefined, 'negative adjustments should not appear in delivery history');
  t.api.close();
});

test('initial stock on product creation appears as a delivery', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const res = await api.call('pos:products:create', adminSession, {
    sku: 'TST-001', name: 'Test Bricks', base_unit: 'pc', stock: 500, cost: 10, price: 15, is_service: false,
  });
  const list = await api.call('pos:reports:stockDeliveries', adminSession, {});
  const entry = list.find((r) => r.product_id === res.id);
  assert.ok(entry, 'initial stock should appear in delivery history');
  assert.equal(entry.qty_change, 500);
  assert.equal(entry.movement, 'restock');
  assert.equal(entry.reason, 'Initial stock');
  t.api.close();
});

test('delivery history list includes product name, sku, and category', async () => {
  const t = await setup();
  const { api, cement, adminSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  await api.call('pos:products:setStock', adminSession, cement.id, before + 30, 'Restock');
  const list = await api.call('pos:reports:stockDeliveries', adminSession, {});
  const entry = list.find((r) => r.product_id === cement.id);
  assert.ok(entry.name, 'product name should be joined');
  assert.ok(entry.sku, 'product sku should be joined');
  assert.ok(entry.base_unit, 'base unit should be joined');
  t.api.close();
});

test('delivery summary counts events, units, and distinct products', async () => {
  const t = await setup();
  const { api, cement, nails, adminSession } = t;
  const cementBefore = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const nailsBefore = api.db.prepare('SELECT stock FROM products WHERE id=?').get(nails.id).stock;
  // setStock sets ABSOLUTE stock, so deltas are: +50, +25, +50 (=125 total)
  await api.call('pos:products:setStock', adminSession, cement.id, cementBefore + 50, 'Delivery 1');
  await api.call('pos:products:setStock', adminSession, nails.id, nailsBefore + 25, 'Delivery 2');
  await api.call('pos:products:setStock', adminSession, cement.id, cementBefore + 100, 'Delivery 3');
  const s = await api.call('pos:reports:stockDeliverySummary', adminSession, {});
  // The 3 new restocks above (seed initial-stock movements may add more)
  assert.ok(s.totals.tx >= 3, `expected >= 3 delivery events, got ${s.totals.tx}`);
  assert.ok(s.totals.units >= 125, `expected >= 125 units, got ${s.totals.units}`);
  assert.ok(s.products >= 2, `expected >= 2 distinct products, got ${s.products}`);
  t.api.close();
});

test('delivery history filters by date range', async () => {
  const t = await setup();
  const { api, cement, adminSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  await api.call('pos:products:setStock', adminSession, cement.id, before + 20, 'Today restock');
  // Filter to today (local date, matching how setStock stores datetime)
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const list = await api.call('pos:reports:stockDeliveries', adminSession, { from: today, to: today });
  assert.ok(list.length > 0, 'should return deliveries from today');
  const old = await api.call('pos:reports:stockDeliveries', adminSession, { from: '2000-01-01', to: '2000-01-02' });
  assert.equal(old.length, 0, 'should return no deliveries from year 2000');
  t.api.close();
});

test('delivery history filters by search query', async () => {
  const t = await setup();
  const { api, cement, adminSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  await api.call('pos:products:setStock', adminSession, cement.id, before + 15, 'Supplier ABC delivery');
  const byName = await api.call('pos:reports:stockDeliveries', adminSession, { q: 'Cement' });
  assert.ok(byName.length > 0);
  assert.ok(byName.some((r) => r.name && r.name.includes('Cement')));
  const byReason = await api.call('pos:reports:stockDeliveries', adminSession, { q: 'Supplier ABC' });
  assert.ok(byReason.length > 0);
  assert.ok(byReason.some((r) => r.reason && r.reason.includes('Supplier ABC')));
  t.api.close();
});

test('cashier can view delivery history (auth, not admin-only)', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  // Cashiers should be able to view the delivery history report
  const list = await api.call('pos:reports:stockDeliveries', cashierSession, {});
  assert.ok(Array.isArray(list), 'cashier should be able to view delivery history');
  const s = await api.call('pos:reports:stockDeliverySummary', cashierSession, {});
  assert.ok(s.totals, 'cashier should be able to view delivery summary');
  t.api.close();
});
