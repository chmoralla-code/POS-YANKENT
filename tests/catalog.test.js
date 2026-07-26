'use strict';
/* Tests: product CRUD, bulk import, stock adjustment, delete-all. */
const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const {
  ensureNewlyAddedItems,
  NEWLY_ADDED_ITEMS_CATEGORY,
  NEWLY_ADDED_ITEMS_SETTING,
} = require('../src/main/db/seed');
const { makeApi } = require('./ipc-harness');

const EXPECTED_NEWLY_ADDED_ITEMS = [
  ['NAI-001', 'GOLDEN CUP Brass Plated Iron Hinges Loose Pin 4x4', 12, 75, 'pcs'],
  ['NAI-002', 'SHERLOCK Door Hinges 3x3', 2, 105, 'pcs'],
  ['NAI-003', 'STANLEY Door Hinges 3" (76mm)', 33, 120, 'pcs'],
  ['NAI-004', 'HOTECHE Iron Padlock 2" / 50mm orange', 2, 140, 'pcs'],
  ['NAI-005', 'HOTECHE Iron Padlock 20mm orange', 7, 41, 'pcs'],
  ['NAI-006', 'EGRNIA Iron Padlock yellow', 2, 50, 'pcs'],
  ['NAI-007', 'TDC Expert in Hinges 3x3 yellow', 5, 80, 'pcs'],
  ['NAI-008', 'TDC Expert in Hinges 4x4 yellow', 1, 90, 'pcs'],
  ['NAI-009', 'STANLEY Door Hinges 4" (101mm)', 29, 180, 'pcs'],
  ['NAI-010', 'TOPGRADE Pin Hinges Steel 3 1/2"', 9, 125, 'pcs'],
  ['NAI-011', 'HOTECHE Heavy duty Iron Padlock 38mm', 1, 85, 'pcs'],
  ['NAI-012', 'Silicone Sealant 300ml', 61, 180, 'pcs'],
  ['NAI-013', '3M Vinyl Electrical tape', 28, 60, 'pcs'],
  ['NAI-014', 'ARMAK Vinyl Electrical tape 0.16 x 19 x 8m', 15, 35, 'pcs'],
  ['NAI-015', 'ARMAK Electrical tape 0.16 x 19 x 4m', 5, 25, 'pcs'],
  ['NAI-016', 'ARMAK Electrical tape 0.16 x 19 x 16m', 26, 50, 'pcs'],
  ['NAI-017', 'ROYU PVC Electrical tape 0.155 x 19 x 16m', 45, 40, 'pcs'],
  ['NAI-018', 'ROYU PVC Electrical tape 0.155 x 19 x 4m', 4, 25, 'pcs'],
  ['NAI-019', 'ROYU PVC Electrical tape 0.155 x 19 x 8m', 50, 30, 'pcs'],
  ['NAI-020', 'LENOX Gabot', 74, 50, 'pcs'],
  ['NAI-021', 'CMART Measuring Tape 7.5m', 6, 265, 'pcs'],
  ['NAI-022', 'CMART Measuring Tape 5m', 5, 145, 'pcs'],
  ['NAI-023', 'HOTECHE Cutter Knife 18mm', 12, 60, 'pcs'],
  ['NAI-024', 'CMART Glue Gun 20W', 5, 198, 'pcs'],
  ['NAI-025', 'CMART Eurotype Stapler', 3, 242, 'pcs'],
  ['NAI-026', 'CMART Adjustable Wrench', 1, 165, 'pcs'],
  ['NAI-027', 'CMART Heavy Duty Staple Gun', 5, 523, 'pcs'],
  ['NAI-028', 'KYK Glue Gun 10W orange', 2, 250, 'pcs'],
  ['NAI-029', 'CMART Lineman Pliers', 6, 215, 'pcs'],
  ['NAI-030', 'CMART High Carbon Steel 1"', 1, 325, 'pcs'],
  ['NAI-031', 'CMART High Carbon Steel 3/4"', 6, 310, 'pcs'],
  ['NAI-032', 'CMART High Carbon Steel 1/2"', 4, 265, 'pcs'],
  ['NAI-033', 'CMART Two Way Screw Drivers', 7, 130, 'pcs'],
  ['NAI-034', 'SHARK Steel Floor Drain 4x4', 6, 250, 'pcs'],
  ['NAI-035', 'ASTERIA Mountain Surface Faucet', 1, 995, 'pcs'],
  ['NAI-036', 'AMERROCK Concealed Hinge', 112, 0, 'pcs'],
  ['NAI-037', 'Sachet Tox with Screw', 255, 2, 'pcs'],
  ['NAI-038', 'Naylon', 145, 50, 'rolls'],
  ['NAI-039', 'Dolphin Naylon Blue', 207, 35, 'rolls'],
  ['NAI-040', 'MAKI HOME Naylon', 8, 35, 'rolls'],
  ['NAI-041', 'Dolphin Naylon Green', 13, 30, 'rolls'],
  ['NAI-042', 'REGINA Faucet Lavatory Big', 5, 900, 'pcs'],
  ['NAI-043', 'XPERT Hand Shower Set', 7, 470, 'pcs'],
  ['NAI-044', 'XPERT Bidet Head', 5, 360, 'pcs'],
  ['NAI-045', 'FASHION Shower Head', 1, 720, 'pcs'],
  ['NAI-046', 'REGINA Shower Valve', 3, 720, 'pcs'],
];

async function setup() {
  const api = await makeApi();
  const admin = api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  return { api, adminSession: createSession(admin), cashierSession: createSession(cashier) };
}

test('fresh catalog contains all Newly Added Items with the requested stock, unit, and price', async () => {
  const t = await setup();
  const rows = t.api.db.prepare(
    `SELECT p.sku,p.name,p.stock,p.price,p.base_unit,u.unit,u.factor,u.price AS unit_price
       FROM products p
       JOIN categories c ON c.id=p.category_id
       JOIN product_units u ON u.product_id=p.id
      WHERE c.name=?
      ORDER BY p.sku`
  ).all(NEWLY_ADDED_ITEMS_CATEGORY);

  assert.deepEqual(
    rows.map((row) => [
      row.sku,
      row.name,
      row.stock,
      row.price,
      row.base_unit,
      row.unit,
      row.factor,
      row.unit_price,
    ]),
    EXPECTED_NEWLY_ADDED_ITEMS.map(([sku, name, stock, price, unit]) =>
      [sku, name, stock, price, unit, unit, 1, price]
    )
  );

  const movementCount = t.api.db.prepare(
    `SELECT COUNT(*) AS count
       FROM stock_movements m
       JOIN products p ON p.id=m.product_id
       JOIN categories c ON c.id=p.category_id
      WHERE c.name=? AND m.movement='restock'`
  ).get(NEWLY_ADDED_ITEMS_CATEGORY);
  assert.equal(movementCount.count, EXPECTED_NEWLY_ADDED_ITEMS.length);
  assert.equal(
    t.api.db.prepare('SELECT value FROM settings WHERE key=?').get(NEWLY_ADDED_ITEMS_SETTING).value,
    '1'
  );
  t.api.close();
});

test('existing-database catalog update runs once and preserves later edits or deletions', async () => {
  const t = await setup();
  const category = t.api.db.prepare('SELECT id FROM categories WHERE name=?')
    .get(NEWLY_ADDED_ITEMS_CATEGORY);
  t.api.db.prepare('DELETE FROM settings WHERE key=?').run(NEWLY_ADDED_ITEMS_SETTING);
  t.api.db.prepare('DELETE FROM products WHERE category_id=?').run(category.id);

  const first = ensureNewlyAddedItems(t.api.db);
  assert.equal(first.inserted, EXPECTED_NEWLY_ADDED_ITEMS.length);
  assert.equal(first.skipped, 0);
  assert.equal(first.alreadyRun, false);

  t.api.db.prepare('UPDATE products SET stock=?,price=? WHERE sku=?').run(999, 999, 'NAI-001');
  const second = ensureNewlyAddedItems(t.api.db);
  assert.equal(second.alreadyRun, true);
  assert.deepEqual(
    t.api.db.prepare('SELECT stock,price FROM products WHERE sku=?').get('NAI-001'),
    { stock: 999, price: 999 }
  );

  t.api.db.prepare('DELETE FROM products WHERE sku=?').run('NAI-020');
  const third = ensureNewlyAddedItems(t.api.db);
  assert.equal(third.alreadyRun, true);
  assert.equal(t.api.db.prepare('SELECT id FROM products WHERE sku=?').get('NAI-020'), undefined);
  t.api.close();
});

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
  const initialMovement = api.db.prepare(
    "SELECT * FROM stock_movements WHERE product_id=? AND movement='restock'"
  ).get(a.id);
  assert.ok(initialMovement);
  assert.equal(initialMovement.qty_change, 5);
  // units attached (Nail B gets a default unit since none provided)
  const b = api.db.prepare('SELECT * FROM products WHERE name=?').get('Test Nail B');
  const bUnits = api.db.prepare('SELECT * FROM product_units WHERE product_id=?').all(b.id);
  assert.equal(bUnits.length, 1);
  assert.equal(bUnits[0].unit, 'kg');
  t.api.close();
});

test('foreign keys are enforced and deleting a category clears product references', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const fk = api.db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(fk.foreign_keys), 1);
  const product = api.db.prepare('SELECT id,category_id FROM products WHERE sku=?').get('CMT-001');
  assert.ok(product.category_id);
  await api.call('pos:categories:delete', adminSession, product.category_id);
  assert.equal(api.db.prepare('SELECT category_id FROM products WHERE id=?').get(product.id).category_id, null);
  t.api.close();
});

test('bulk import rejects negative inventory, prices, and invalid units atomically', async () => {
  const invalidItems = [
    { name: 'Negative Import Stock', stock: -5, price: 10 },
    { name: 'Negative Import Price', stock: 1, price: -10 },
    { name: 'Negative Import Factor', stock: 1, price: 10, units: [{ unit: 'box', factor: -2, price: 10 }] },
    { name: 'Negative Import Unit Price', stock: 1, price: 10, units: [{ unit: 'box', factor: 2, price: -20 }] },
  ];
  for (const item of invalidItems) {
    const t = await setup();
    await assert.rejects(
      () => t.api.call('pos:products:bulkImport', t.adminSession, [item]),
      /non-negative|greater than zero/
    );
    assert.equal(t.api.db.prepare('SELECT id FROM products WHERE name=?').get(item.name), undefined);
    t.api.close();
  }
});

test('stock adjustment rejects malformed calendar dates without changing stock', async () => {
  const t = await setup();
  const cement = t.api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  await assert.rejects(
    () => t.api.call('pos:products:setStock', t.adminSession, cement.id, cement.stock + 1, 'bad date', '2026-02-30'),
    /valid date/i
  );
  assert.equal(t.api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock, cement.stock);
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

test('catalog import allocates a safe SKU after Delete All retains an inactive fixed SKU', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const catalog = require('../src/renderer/assets/product-catalog.json');
  const item = catalog.find((entry) => entry.sku === 'NAI-001');
  assert.ok(item);

  await api.call('pos:products:deleteAll', adminSession);
  const retained = api.db.prepare('SELECT id,active FROM products WHERE sku=?').get(item.sku);
  assert.ok(retained);
  assert.equal(retained.active, 0);

  const result = await api.call('pos:products:bulkImport', adminSession, [item]);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
  const restored = api.db.prepare('SELECT sku,active,stock,price FROM products WHERE name=? AND active=1')
    .get(item.name);
  assert.deepEqual(restored, {
    sku: 'NAI-001-2',
    active: 1,
    stock: item.stock,
    price: item.price,
  });
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

test('setStock rejects negative and non-numeric inventory values', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const cement = api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  await assert.rejects(() => api.call('pos:products:setStock', adminSession, cement.id, -1, 'bad'), /non-negative/);
  await assert.rejects(() => api.call('pos:products:setStock', adminSession, cement.id, 'not-a-number', 'bad'), /non-negative/);
  assert.equal(api.db.prepare('SELECT stock FROM products WHERE id=?').get(cement.id).stock, cement.stock);
  t.api.close();
});

test('product creation rejects invalid prices and unit factors', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  await assert.rejects(() => api.call('pos:products:create', adminSession, {
    name: 'Negative Price', base_unit: 'pc', stock: 1, price: -10,
  }), /Price must be a non-negative number/);
  await assert.rejects(() => api.call('pos:products:create', adminSession, {
    name: 'Bad Factor', base_unit: 'pc', stock: 1, price: 10,
    units: [{ unit: 'box', factor: 0, price: 10 }],
  }), /factor must be greater than zero/);
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

test('create service is flagged is_service and appears in services-only list', async () => {
  const t = await setup();
  const { api, adminSession } = t;
  const created = await api.call('pos:products:create', adminSession, {
    name: 'Test Delivery Fee',
    base_unit: 'svc',
    stock: 99, // must be forced to 0 for services
    price: 350,
    is_service: true,
    units: [{ unit: 'svc', factor: 1, price: 350 }],
  });
  assert.ok(created.id);
  const row = api.db.prepare('SELECT * FROM products WHERE id=?').get(created.id);
  assert.equal(row.is_service, 1);
  assert.equal(row.stock, 0);
  assert.equal(row.active, 1);
  const units = api.db.prepare('SELECT * FROM product_units WHERE product_id=?').all(created.id);
  assert.equal(units.length, 1);
  assert.equal(units[0].unit, 'svc');
  assert.equal(units[0].price, 350);

  const list = await api.call('pos:products:list', adminSession, { includeServices: true });
  const found = list.find((p) => p.id === created.id);
  assert.ok(found, 'service must appear in catalog list');
  assert.ok(found.is_service, 'is_service must be truthy for renderer filters');
  assert.ok(found.units && found.units.length >= 1, 'service must have sell units');

  const servicesOnly = await api.call('pos:products:list', adminSession, { servicesOnly: true });
  assert.ok(servicesOnly.every((p) => p.is_service), 'servicesOnly returns only services');
  assert.ok(servicesOnly.find((p) => p.id === created.id), 'new service visible in servicesOnly list');

  // POS products tab must not include services when includeServices is false
  const productsOnly = await api.call('pos:products:list', adminSession, { includeServices: false });
  assert.ok(!productsOnly.find((p) => p.id === created.id));
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
