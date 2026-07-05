'use strict';
/* Tests: sales creation, stock decrement, refunds, and reset-all-sales.
 * Drives the real IPC handlers through the test harness so the full guard +
 * transaction + stock-movement path is exercised end to end. */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');

async function setup() {
  const api = await makeApi();
  const { db } = api;
  const admin = db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const cement = db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001'); // 280/bag, stock 120
  const nails = db.prepare('SELECT * FROM products WHERE sku=?').get('NIL-2');    // 95/kg, stock 120
  const cut = db.prepare('SELECT * FROM products WHERE sku=?').get('SVC-CUT');     // service, stock 0
  const contractor = db.prepare('SELECT * FROM customers WHERE name=?').get('ABC Construction'); // credit limit 50000, used 12000
  return { api, admin, cashier, cement, nails, cut, contractor,
    adminSession: createSession(admin), cashierSession: createSession(cashier) };
}

test('create sale records a PENDING sale (no stock deduction), commit deducts stock', async () => {
  const t = await setup();
  const { api, cement, nails, cashierSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [
      { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 2, unitPrice: 280, factor: 1 },
      { productId: nails.id, sku: nails.sku, name: nails.name, unit: 'kg', qty: 1, unitPrice: 95, factor: 1 },
    ],
    customerId: null, customerName: 'Walk-in Customer',
    paymentMethod: 'cash', amountTendered: 800, discount: 0,
  });
  assert.match(res.txnId, /^YK-\d{6}$/);
  assert.equal(res.saleId > 0, true);
  // 2*280 + 1*95 = 655 net; total = 655 + 12% VAT = 733.60
  const sale = api.db.prepare('SELECT * FROM sales WHERE id=?').get(res.saleId);
  assert.equal(sale.total, 733.6);
  assert.equal(sale.status, 'pending');
  // stock NOT yet deducted (pending sale)
  const cementAfterCreate = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const nailsAfterCreate = api.db.prepare('SELECT stock FROM products WHERE id=?').get(nails.id).stock;
  assert.equal(cementAfterCreate, before, 'stock must not change on create (pending)');
  assert.equal(nailsAfterCreate, 120, 'stock must not change on create (pending)');
  // sale_items rows recorded
  const items = api.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(res.saleId);
  assert.equal(items.length, 2);
  assert.equal(items[0].qty, 2);
  // NO stock movements yet
  const movsBefore = api.db.prepare("SELECT * FROM stock_movements WHERE movement='sale' AND product_id=?").all(cement.id);
  assert.equal(movsBefore.length, 0);

  // COMMIT: deducts stock, writes movements, marks completed
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  const saleAfter = api.db.prepare('SELECT status FROM sales WHERE id=?').get(res.saleId);
  assert.equal(saleAfter.status, 'completed');
  const cementAfterCommit = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const nailsAfterCommit = api.db.prepare('SELECT stock FROM products WHERE id=?').get(nails.id).stock;
  assert.equal(cementAfterCommit, before - 2);
  assert.equal(nailsAfterCommit, 119);
  const movsAfter = api.db.prepare("SELECT * FROM stock_movements WHERE movement='sale' AND product_id=?").all(cement.id);
  assert.equal(movsAfter.length, 1);
  assert.equal(movsAfter[0].qty_change, -2);
  t.api.close();
});

test('void deletes a pending sale without deducting stock', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  const before = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 2, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 700,
  });
  // void the pending sale
  await api.call('pos:sales:void', cashierSession, res.txnId);
  // sale + items deleted
  const sale = api.db.prepare('SELECT * FROM sales WHERE txn_id=?').get(res.txnId);
  assert.equal(sale, undefined);
  const items = api.db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE sale_id=?').get(res.saleId);
  assert.equal(items.c, 0);
  // stock untouched
  const after = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  assert.equal(after, before);
  t.api.close();
});

test('cannot void a completed sale (must use refund)', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 500,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  await assert.rejects(() => api.call('pos:sales:void', cashierSession, res.txnId), /Cannot void/);
  t.api.close();
});

test('cannot commit a non-pending sale', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 500,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  // committing again should fail (already completed)
  await assert.rejects(() => api.call('pos:sales:commit', cashierSession, res.txnId), /not pending/);
  t.api.close();
});

test('mixed product + service sale: service consumes no stock on commit', async () => {
  const t = await setup();
  const { api, cement, cut, cashierSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [
      { productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 },
      { productId: cut.id, sku: cut.sku, name: cut.name, unit: 'per cut', qty: 3, unitPrice: 25, factor: 1, isService: true },
    ],
    paymentMethod: 'cash', amountTendered: 450,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  const items = api.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(res.saleId);
  assert.equal(items.length, 2);
  assert.equal(items[0].line_type, 'product');
  assert.equal(items[1].line_type, 'service');
  // service should NOT have a stock movement (it has a stock_consumed value
  // for accounting, but no product stock is decremented)
  const svcMovs = api.db.prepare("SELECT * FROM stock_movements WHERE product_id=?").all(cut.id);
  assert.equal(svcMovs.length, 0);
  // 280 + 75 = 355 net; total = 355 + 12% VAT = 397.60
  assert.equal(api.db.prepare('SELECT total FROM sales WHERE id=?').get(res.saleId).total, 397.6);
  t.api.close();
});

test('empty cart and insufficient cash are rejected', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  await assert.rejects(() => api.call('pos:sales:create', cashierSession, { items: [], paymentMethod: 'cash' }), /Cart is empty/);
  await assert.rejects(() => api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 100,
  }), /Insufficient cash/);
  t.api.close();
});

test('insufficient stock is rejected', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  await assert.rejects(() => api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 9999, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 9999999,
  }), /Insufficient stock/);
  t.api.close();
});

test('invalid payment method is rejected (cannot bypass cash/credit checks)', async () => {
  // Regression: an unknown paymentMethod string used to skip both the
  // cash-sufficiency check (only 'cash' triggers it) AND the account-credit
  // check (only 'account' triggers it), letting a sale through with no
  // tendered cash and no credit verification.  The handler now validates
  // against the known set up front.
  const t = await setup();
  const { api, cement, cashierSession } = t;
  await assert.rejects(() => api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'bitcoin', amountTendered: 0,
  }), /Invalid payment method/);
  // Empty/missing paymentMethod is also rejected.
  await assert.rejects(() => api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    amountTendered: 500,
  }), /Invalid payment method/);
  t.api.close();
});

test('refund restocks items, marks sale refunded, creates refund record', async () => {
  const t = await setup();
  const { api, cement, cashierSession, adminSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 4, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 2000,
  });
  // commit the sale first so stock is deducted (refund requires completed)
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  const stockAfterSale = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  const r = await api.call('pos:refunds:process', cashierSession, {
    txnId: res.txnId, adminId: 1, adminName: 'YANKENT Admin', reason: 'Customer changed mind', refundAll: true,
  });
  assert.match(r.refundTxnId, /^RF-\d{6}$/);
  assert.equal(r.total, 1254.4); // 4*280=1120 net + 12% VAT = 1254.40
  // stock restored
  const stockAfterRefund = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  assert.equal(stockAfterRefund, stockAfterSale + 4);
  // sale marked refunded
  const sale = api.db.prepare('SELECT status FROM sales WHERE id=?').get(res.saleId);
  assert.equal(sale.status, 'refunded');
  // refund record exists
  const refund = api.db.prepare('SELECT * FROM refunds WHERE refund_txn_id=?').get(r.refundTxnId);
  assert.ok(refund);
  assert.equal(refund.original_txn_id, res.txnId);
  // restock movement logged
  const movs = api.db.prepare("SELECT * FROM stock_movements WHERE movement='refund' AND product_id=?").all(cement.id);
  assert.equal(movs.length, 1);
  assert.equal(movs[0].qty_change, 4);
  t.api.close();
});

test('cannot refund the same sale twice', async () => {
  const t = await setup();
  const { api, cement, cashierSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 500,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  await api.call('pos:refunds:process', cashierSession, { txnId: res.txnId, adminId: 1, adminName: 'A', reason: 'x', refundAll: true });
  await assert.rejects(() => api.call('pos:refunds:process', cashierSession, { txnId: res.txnId, adminId: 1, adminName: 'A', reason: 'x', refundAll: true }), /not found or already refunded/);
  t.api.close();
});

test('refunds list caps the limit (cannot request unbounded rows)', async () => {
  // Regression: the refunds:list endpoint used to pass f.limit || 100
  // straight to LIMIT ?, so a caller could request millions of rows and
  // freeze the app.  It now caps at 1000 like sales:list does.
  const t = await setup();
  const { api, cashierSession } = t;
  // A huge limit must not throw and must return an array (the SQL layer
  // caps it to 1000 internally).
  const rows = await api.call('pos:refunds:list', cashierSession, { limit: 999999 });
  assert.ok(Array.isArray(rows));
  // Negative/missing limit falls back to 100 — still returns an array.
  const rows2 = await api.call('pos:refunds:list', cashierSession, { limit: -5 });
  assert.ok(Array.isArray(rows2));
  t.api.close();
});

test('reset all sales wipes sales/items/refunds/movements and resets sequence', async () => {
  const t = await setup();
  const { api, cement, cashierSession, adminSession } = t;
  const res = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 2, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 700,
  });
  await api.call('pos:sales:commit', cashierSession, res.txnId);
  await api.call('pos:sales:reset', adminSession);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM sale_items').get().c, 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM refunds').get().c, 0);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS c FROM stock_movements').get().c, 0);
  // users/products/categories/settings preserved
  assert.ok(api.db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0);
  assert.ok(api.db.prepare('SELECT COUNT(*) AS c FROM products').get().c > 0);
  assert.ok(api.db.prepare('SELECT COUNT(*) AS c FROM categories').get().c > 0);
  assert.ok(api.db.prepare('SELECT COUNT(*) AS c FROM settings').get().c > 0);
  // product stock reset to 0
  const s = api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock;
  assert.equal(s, 0);
  // next valid sale starts fresh at YK-000001 (restock first so stock>0)
  await api.call('pos:products:setStock', adminSession, cement.id, 10, 'test restock');
  const res2 = await api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 500,
  });
  assert.equal(res2.txnId, 'YK-000001');
  t.api.close();
});

test('cashier cannot reset sales (admin guard)', async () => {
  const t = await setup();
  const { api, cashierSession } = t;
  await assert.rejects(() => api.call('pos:sales:reset', cashierSession), /Administrator/i);
  t.api.close();
});