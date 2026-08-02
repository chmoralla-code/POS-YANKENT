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
  assert.equal(report.dataScope, 'inventory');
  assert.match(report.scopeNote, /paid sales and Utang transactions are not included/);
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
    missing_cost_count: 0,
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

test('Add Item creates one synced product for margin table, inventory, and POS', async () => {
  const t = await setup();
  const created = await t.api.call('pos:margins:addItem', t.adminSession, {
    name: 'Margin Sync Test Item',
    unit: 'bundle',
    stock: 7,
    purchase_source: 'Cogon Test Depot',
    selling_price: 175,
    low_stock_threshold: 2,
  });

  assert.equal(created.category, CATEGORY_NAME);
  assert.deepEqual(
    {
      name: created.row.name,
      unit: created.row.unit,
      stock: created.row.stock,
      source: created.row.purchase_source,
      price: created.row.selling_price,
      cost: created.row.computed_cost,
      unitProfit: created.row.unit_profit,
      gross: created.row.potential_gross_profit,
    },
    {
      name: 'Margin Sync Test Item',
      unit: 'bundle',
      stock: 7,
      source: 'Cogon Test Depot',
      price: 175,
      cost: 160,
      unitProfit: 15,
      gross: 105,
    }
  );

  const product = await t.api.call('pos:products:get', t.adminSession, created.id);
  assert.equal(product.category, CATEGORY_NAME);
  assert.match(product.sku, /^P-\d{5,}$/);
  assert.equal(product.base_unit, 'bundle');
  assert.equal(product.stock, 7);
  assert.equal(product.cost, 160);
  assert.equal(product.price, 175);
  assert.equal(product.purchase_source, 'Cogon Test Depot');
  assert.equal(product.margin_original_cost, null);
  assert.equal(product.low_stock_threshold, 2);
  assert.deepEqual(
    product.units.map(({ unit, factor, price }) => ({ unit, factor, price })),
    [{ unit: 'bundle', factor: 1, price: 175 }]
  );

  const catalog = await t.api.call(
    'pos:products:list',
    t.adminSession,
    { q: 'Margin Sync Test Item' }
  );
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, created.id);
  assert.equal(catalog[0].category, CATEGORY_NAME);

  const movement = t.api.db.prepare(
    `SELECT movement,qty_change,reason,user_id,source_location
       FROM stock_movements WHERE product_id=?`
  ).get(created.id);
  assert.deepEqual(movement, {
    movement: 'restock',
    qty_change: 7,
    reason: 'Initial stock (Margin Table Add Item)',
    user_id: t.adminSession.id,
    source_location: 'Cogon Test Depot',
  });

  const readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.canGenerate, true);
  assert.equal(readiness.rows.some((row) => row.id === created.id), true);
  t.api.close();
});

test('Add Item validates low-price cost and prevents duplicate active products', async () => {
  const t = await setup();
  const before = t.api.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

  await assert.rejects(
    () => t.api.call('pos:margins:addItem', t.adminSession, {
      name: 'Five Peso Item',
      unit: 'pc',
      stock: 3,
      purchase_source: 'Supplier',
      selling_price: 5,
      low_stock_threshold: 1,
    }),
    /Original price.*required/i
  );
  assert.equal(t.api.db.prepare('SELECT COUNT(*) AS n FROM products').get().n, before);

  const created = await t.api.call('pos:margins:addItem', t.adminSession, {
    name: 'Five Peso Item',
    unit: 'pc',
    stock: 3,
    purchase_source: 'Supplier',
    selling_price: 5,
    original_cost: 2.5,
    low_stock_threshold: 1,
  });
  assert.equal(created.row.computed_cost, 2.5);
  assert.equal(created.row.unit_profit, 2.5);
  assert.equal(created.row.potential_gross_profit, 7.5);

  const saved = await t.api.call('pos:products:get', t.adminSession, created.id);
  assert.equal(saved.cost, 2.5);
  assert.equal(saved.margin_original_cost, 2.5);

  await assert.rejects(
    () => t.api.call('pos:margins:addItem', t.adminSession, {
      name: '  five peso item  ',
      unit: 'pc',
      stock: 1,
      purchase_source: 'Other Supplier',
      selling_price: 6,
      original_cost: 3,
    }),
    /already exists/i
  );
  assert.equal(
    t.api.db.prepare(
      "SELECT COUNT(*) AS n FROM products WHERE LOWER(TRIM(name))='five peso item' AND active=1"
    ).get().n,
    1
  );
  t.api.close();
});

test('prices below the fixed margin still generate with blank original cost', async () => {
  assert.equal(unitProfitFor(100), 10);
  assert.equal(unitProfitFor(100.01), 15);
  assert.equal(unitProfitFor(200), 15);
  assert.equal(unitProfitFor(200.01), 20);

  const t = await setup();
  const lowId = t.add({ sku: 'M-LOW', name: 'Too Low', stock: 2, price: 9.99, source: 'Supplier' });
  const readiness = await t.api.call('pos:margins:readiness', t.adminSession);
  assert.equal(readiness.eligibleCount, 1);
  assert.equal(readiness.manualCostCount, 1);
  assert.equal(readiness.canGenerate, true);
  assert.equal(readiness.rows[0].needs_manual_cost, true);
  assert.equal(readiness.rows[0].computed_cost, null);

  const report = await t.api.call('pos:margins:generate', t.adminSession);
  assert.equal(report.summary.missing_cost_count, 1);
  assert.equal(report.rows[0].computed_cost, null);
  assert.equal(report.rows[0].potential_gross_profit, null);

  const saved = await t.api.call('pos:margins:setOriginalCost', t.adminSession, lowId, 4.5);
  assert.equal(saved.margin_original_cost, 4.5);
  assert.equal(saved.row.computed_cost, 4.5);
  assert.equal(saved.row.unit_profit, 5.49);
  assert.equal(saved.row.potential_gross_profit, 10.98);
  assert.equal(saved.row.needs_manual_cost, false);

  const filled = await t.api.call('pos:margins:generate', t.adminSession);
  assert.equal(filled.summary.missing_cost_count, 0);
  assert.equal(filled.rows[0].computed_cost, 4.5);
  assert.equal(filled.summary.potential_gross_profit, 10.98);

  await assert.rejects(
    () => t.api.call('pos:margins:setOriginalCost', t.adminSession, lowId, 20),
    /lower than the selling price/i
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
    () => t.api.call('pos:margins:addItem', t.cashierSession, {
      name: 'Forbidden Item',
      unit: 'pc',
      stock: 1,
      purchase_source: 'Supplier',
      selling_price: 50,
    }),
    () => t.api.call('pos:margins:generate', t.cashierSession),
    () => t.api.call('pos:margins:setSource', t.cashierSession, productId, 'Other'),
    () => t.api.call('pos:margins:bulkSetSource', t.cashierSession, [productId], 'Other'),
    () => t.api.call('pos:margins:setOriginalCost', t.cashierSession, productId, 50),
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
