'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const { CATEGORY_NAME, unitProfitFor } = require('../src/main/ipc/margins');

async function setup() {
  const api = await makeApi();
  const admin = api.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const cashier = api.db.prepare("SELECT * FROM users WHERE username='cashier'").get();
  const category = api.db.prepare('SELECT id FROM categories WHERE name=?').get(CATEGORY_NAME);
  assert.ok(category, 'Newly Added Items fixture category must exist');

  // Isolate these tests from the large seeded catalog while retaining the
  // real category and IPC stack.
  api.db.prepare('UPDATE products SET active=0 WHERE category_id=?').run(category.id);

  const add = ({
    sku, name, stock, price, source = null, active = 1,
    service = 0, categoryId = category.id, unit = 'pc',
  }) => api.db.prepare(
    `INSERT INTO products(
       sku,name,category_id,base_unit,stock,cost,price,purchase_source,
       low_stock_threshold,is_service,active
     ) VALUES(?,?,?,?,?,?,?,?,0,?,?)`
  ).run(
    sku, name, categoryId, unit, stock, 0, price, source,
    service, active
  ).lastInsertRowid;

  return {
    api,
    add,
    categoryId: category.id,
    adminSession: createSession(admin),
    cashierSession: createSession(cashier),
  };
}

test('margin table generates computed cost and stock gross from live base prices', async () => {
  const t = await setup();
  t.add({ sku: 'M-100', name: 'At 100', stock: 2, price: 100, source: 'Supplier A' });
  t.add({ sku: 'M-150', name: 'At 150', stock: 3, price: 150, source: 'Supplier B' });
  t.add({ sku: 'M-250', name: 'At 250', stock: 1.5, price: 250, source: 'Supplier C', unit: 'kg' });

  const report = await t.api.call('pos:margins:generate', t.adminSession);
  assert.equal(report.category, CATEGORY_NAME);
  assert.equal(report.rows.length, 3);
  assert.deepEqual(
    report.rows.map((row) => ({
      price: row.selling_price,
      cost: row.computed_cost,
      unitProfit: row.unit_profit,
      gross: row.potential_gross_profit,
    })),
    [
      { price: 100, cost: 90, unitProfit: 10, gross: 20 },
      { price: 150, cost: 135, unitProfit: 15, gross: 45 },
      { price: 250, cost: 230, unitProfit: 20, gross: 30 },
    ]
  );
  assert.deepEqual(report.summary, {
    item_count: 3,
    total_stock: 6.5,
    retail_value: 1025,
    computed_cost: 930,
    potential_gross_profit: 95,
  });

  // The result is live, not a saved report snapshot.
  const firstId = report.rows[0].id;
  t.api.db.prepare('UPDATE products SET stock=?, price=? WHERE id=?').run(4, 80, firstId);
  const refreshed = await t.api.call('pos:margins:generate', t.adminSession);
  const changed = refreshed.rows.find((row) => row.id === firstId);
  assert.equal(changed.computed_cost, 70);
  assert.equal(changed.potential_gross_profit, 40);
  t.api.close();
});

test('margin boundaries use the stored selling price and invalid prices block generation', async () => {
  assert.equal(unitProfitFor(100), 10);
  assert.equal(unitProfitFor(100.01), 15);
  assert.equal(unitProfitFor(200), 15);
  assert.equal(unitProfitFor(200.01), 20);

  const t = await setup();
  t.add({ sku: 'M-LOW', name: 'Too Low', stock: 1, price: 9.99, source: 'Supplier' });
  const readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.eligibleCount, 1);
  assert.equal(readiness.invalidPriceCount, 1);
  assert.equal(readiness.canGenerate, false);
  assert.match(readiness.rows[0].price_error, /at least/i);
  await assert.rejects(
    () => t.api.call('pos:margins:generate', t.adminSession),
    /invalid selling price/i
  );
  t.api.close();
});

test('readiness requires saved sources and source APIs support individual and bulk entry', async () => {
  const t = await setup();
  const first = t.add({ sku: 'M-A', name: 'Item A', stock: 1, price: 75 });
  const second = t.add({ sku: 'M-B', name: 'Item B', stock: 2, price: 175 });

  let readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.missingSourceCount, 2);
  assert.equal(readiness.canGenerate, false);

  await t.api.call('pos:margins:setSource', t.adminSession, first, '  Tagbilaran Depot  ');
  const bulk = await t.api.call(
    'pos:margins:bulkSetSource',
    t.adminSession,
    [second, second],
    'Cortes Supplier'
  );
  assert.equal(bulk.updated, 1);

  readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.missingSourceCount, 0);
  assert.equal(readiness.canGenerate, true);
  assert.equal(
    readiness.rows.find((row) => row.id === first).purchase_source,
    'Tagbilaran Depot'
  );
  assert.equal(
    readiness.rows.find((row) => row.id === second).purchase_source,
    'Cortes Supplier'
  );

  await assert.rejects(
    () => t.api.call('pos:margins:setSource', t.adminSession, first, 'x'.repeat(201)),
    /cannot exceed/i
  );
  t.api.close();
});

test('margin scope excludes other categories, services, inactive, and zero-stock products', async () => {
  const t = await setup();
  const otherCategory = t.api.db.prepare(
    "INSERT INTO categories(name,sort) VALUES('Margin Test Other',999)"
  ).run().lastInsertRowid;
  const included = t.add({
    sku: 'M-IN', name: 'Included', stock: 1, price: 50, source: 'Supplier',
  });
  t.add({
    sku: 'M-ZERO', name: 'Zero stock', stock: 0, price: 50, source: 'Supplier',
  });
  t.add({
    sku: 'M-OFF', name: 'Inactive', stock: 1, price: 50, source: 'Supplier', active: 0,
  });
  t.add({
    sku: 'M-SVC', name: 'Service', stock: 1, price: 50, source: 'Supplier', service: 1,
  });
  t.add({
    sku: 'M-OTHER', name: 'Other category', stock: 1, price: 50,
    source: 'Supplier', categoryId: otherCategory,
  });

  const readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.eligibleCount, 1);
  assert.equal(readiness.rows[0].id, included);
  t.api.close();
});

test('margin endpoints are administrator-only', async () => {
  const t = await setup();
  const productId = t.add({
    sku: 'M-SEC', name: 'Private Margin', stock: 1, price: 100, source: 'Supplier',
  });
  for (const call of [
    () => t.api.call('pos:margins:readiness', t.cashierSession),
    () => t.api.call('pos:margins:generate', t.cashierSession),
    () => t.api.call('pos:margins:setSource', t.cashierSession, productId, 'Other'),
    () => t.api.call('pos:margins:bulkSetSource', t.cashierSession, [productId], 'Other'),
    () => t.api.call('pos:margins:exportExcel', t.cashierSession),
    () => t.api.call('pos:margins:exportPdf', t.cashierSession),
  ]) {
    await assert.rejects(call, /Administrator access required/);
  }
  t.api.close();
});

test('restock history does not bypass the required margin-table source review', async () => {
  const t = await setup();
  const productId = t.add({
    sku: 'M-RST', name: 'Restocked', stock: 5, price: 100,
  });

  await t.api.call(
    'pos:products:setStock',
    t.adminSession,
    productId,
    8,
    'New delivery',
    '2026-07-28',
    'New Supplier'
  );
  assert.equal(
    t.api.db.prepare('SELECT purchase_source FROM products WHERE id=?').get(productId).purchase_source,
    null
  );
  const readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.missingSourceCount, 1);
  assert.equal(readiness.canGenerate, false);

  await t.api.call(
    'pos:products:setStock',
    t.adminSession,
    productId,
    7,
    'Damaged item',
    '2026-07-28',
    'Should Not Replace'
  );
  assert.equal(
    t.api.db.prepare('SELECT purchase_source FROM products WHERE id=?').get(productId).purchase_source,
    null
  );
  t.api.close();
});
