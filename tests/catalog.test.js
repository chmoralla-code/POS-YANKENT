'use strict';
/* Tests: product CRUD, bulk import, stock adjustment, delete-all. */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');

async function setup() {
  const api = await makeApi();
  const admin = api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  return { api, adminSession: createSession(admin), cashierSession: createSession(cashier) };
}

test('bulk import creates products + categories, skips duplicates, attaches units', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const items = [
    { name: 'Test Cement A', category: 'Test Cement', baseUnit: 'bag', stock: 5, price: 300, units: [{ unit: 'bag', factor: 1, price: 300 }] },
    { name: 'Test Nail B', category: 'Test Nails', baseUnit: 'kg', stock: 0, price: 0, units: [] },
    { name: '', category: 'Test Cement', baseUnit: 'pc', stock: 0, price: 0, units: [] }, // skipped (empty name)
  ];
  const r = await api.call('pos:products:bulkImport', adminSession, items);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 1);
  assert.ok(r.categories.includes('Test Cement'));
  assert.ok(r.categories.includes('Test Nails'));
  // products exist
  const a = api.db.prepare('SELECT * FROM products WHERE name=?').get('Test Cement A');
  assert.ok(a);
  assert.equal(a.stock, 5);
  assert.equal(a.price, 300);
  // units attached (Nail B gets a default unit since none provided)
  const b = api.db.prepare('SELECT * FROM products WHERE name=?').get('Test Nail B');
  const bUnits = api.db.prepare('SELECT * FROM product_units WHERE product_id=?').all(b.id);
  assert.equal(bUnits.length, 1);
  assert.equal(bUnits[0].unit, 'kg');
  t.api.close();
});

test('re-importing the same names skips them (idempotent)', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const items = [{ name: 'Idempotent Item', category: 'Idem Cat', baseUnit: 'pc', stock: 1, price: 10, units: [{ unit: 'pc', factor: 1, price: 10 }] }];
  const r1 = await api.call('pos:products:bulkImport', adminSession, items);
  assert.equal(r1.imported, 1);
  const r2 = await api.call('pos:products:bulkImport', adminSession, items);
  assert.equal(r2.imported, 0);
  assert.equal(r2.skipped, 1);
  t.api.close();
});

test('cashier cannot bulk import (admin guard)', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  await assert.rejects(() => api.call('pos:products:bulkImport', cashierSession, []), /Administrator/i);
  t.api.close();
});

test('setStock updates stock and logs a movement with the delta', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const before = cement.stock;
  const r = await api.call('pos:products:setStock', adminSession, cement.id, before + 10, 'test restock');
  assert.equal(r.stock, before + 10);
  assert.equal(r.delta, 10);
  const after = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  assert.equal(after, before + 10);
  const movs = api.db.prepare("SELECT * FROM stock_movements WHERE product_id=? AND movement='adjustment' ORDER BY id DESC LIMIT 1").all(cement.id);
  assert.equal(movs.length, 1);
  assert.equal(movs[0].qty_change, 10);
  t.api.close();
});

test('setStock rejects a service product', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const cut = api.db.prepare('SELECT * FROM products WHERE sku=?').get('SVC-CUT');
  await assert.rejects(() => api.call('pos:products:setStock', adminSession, cut.id, 5, 'x'), /Cannot set stock for a service/);
  t.api.close();
});

test('delete product soft-deletes (active=0); deleteAll wipes + resets sequence', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  await api.call('pos:products:delete', adminSession, cement.id);
  const stillThere = api.db.prepare('SELECT active FROM products WHERE id=?').get(cement.id);
  assert.equal(stillThere.active, 0);
  // list (active=1) should not include it
  const list = await api.call('pos:products:list', adminSession, { includeServices: true });
  assert.ok(!list.find((p) => p.id === cement.id));

  const r = await api.call('pos:products:deleteAll', adminSession);
  assert.ok(r.products > 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM products WHERE active=1').get().c, 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM product_units').get().c, 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM stock_movements').get().c, 0);
  // categories preserved
  assert.ok(api.db.prepare('SELECT COUNT(*) AS c FROM categories').get().c > 0);
  t.api.close();
});

test('editing a product preserves active (does not soft-delete it)', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  assert.equal(cement.active, 1);
  // The Edit form never sends `active`. Updating must keep it active=1.
  await api.call('pos:products:update', adminSession, cement.id, {
    sku: cement.sku, name: cement.name, category_id: cement.category_id,
    base_unit: cement.base_unit, cost: 200, price: 290,
    low_stock_threshold: 10, is_service: 0,
    units: [{ unit: 'bag', factor: 1, price: 290 }],
  });
  const after = api.db.prepare('SELECT active, price, cost FROM products WHERE id=?').get(cement.id);
  assert.equal(after.active, 1, 'product must stay active after edit');
  assert.equal(after.price, 290);
  assert.equal(after.cost, 200);
  // still visible in the catalog list (which filters active=1)
  const list = await api.call('pos:products:list', adminSession, { includeServices: true });
  assert.ok(list.find((p) => p.id === cement.id), 'edited product must remain in the list');
  t.api.close();
});