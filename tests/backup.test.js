'use strict';
/* Tests: backup export/import round-trip preserves all data. */
const test = require('node:test');
const assert = require('node:assert');
const { freshDb } = require('./dbutil');
const { exportAll, importAll } = require('../src/main/backup');

test('export/import round-trip restores products, sales, settings', async () => {
  const a = await freshDb();
  // Insert a representative sale (numbers match money.test.js: total 614)
  const saleCols = ['txn_id','seq','datetime','cashier_id','cashier_name','customer_name','subtotal','vat','discount','delivery_fee','total','payment_method','amount_tendered','change','reference','status'];
  const saleArgs = ['YK-000001', 1, '2026-06-30 10:00:00', 1, 'Admin', 'Walk-in Customer', 548.21, 65.79, 0, 0, 614.00, 'cash', 700, 86, null, 'completed'];
  const ph = saleCols.map(() => '?').join(',');
  const saleId = a.db.prepare(`INSERT INTO sales (${saleCols.join(',')}) VALUES (${ph})`).run(...saleArgs).lastInsertRowid;
  const itemCols = ['sale_id','product_id','sku','name','unit','qty','unit_price','amount','line_type','stock_consumed'];
  const iph = itemCols.map(() => '?').join(',');
  a.db.prepare(`INSERT INTO sale_items (${itemCols.join(',')}) VALUES (${iph})`).run(saleId, 1, 'CMT-001', 'Portland Cement 40kg', 'bag', 2, 280, 560, 'product', 2);

  const beforeProducts = a.db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const beforeUsers = a.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const data = exportAll(a.db);
  assert.equal(data.app, 'YANKENT POS');
  assert.ok(data.tables.sales.length >= 1);
  assert.equal(data.tables.products.length, beforeProducts);

  // Restore into a fresh DB (which had its own seed) — should become a's data.
  const b = await freshDb();
  importAll(b.db, data);
  assert.equal(b.db.prepare('SELECT COUNT(*) AS c FROM products').get().c, beforeProducts);
  assert.equal(b.db.prepare('SELECT COUNT(*) AS c FROM users').get().c, beforeUsers);
  const sale = b.db.prepare('SELECT txn_id, total, subtotal, vat, status FROM sales WHERE txn_id=?').get('YK-000001');
  assert.ok(sale);
  assert.equal(sale.total, 614);
  assert.equal(sale.subtotal, 548.21);
  assert.equal(sale.vat, 65.79);
  assert.equal(sale.status, 'completed');
  const items = b.db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId || (b.db.prepare('SELECT id FROM sales WHERE txn_id=?').get('YK-000001').id));
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 560);

  // settings preserved
  const sn = b.db.prepare("SELECT value FROM settings WHERE key='store_name'").get();
  assert.equal(sn.value, 'YANKENT POS');

  a.close(); b.close();
});

test('import rejects invalid backup files', async () => {
  const { db, close } = await freshDb();
  assert.throws(() => importAll(db, null), /Invalid backup/);
  assert.throws(() => importAll(db, { tables: {} }), /missing table/);
  close();
});
