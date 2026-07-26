'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_DEMO_CLEANUP_SETTING = 'legacy_demo_customers_removed_v1';
const NEWLY_ADDED_ITEMS_CATEGORY = 'Newly Added Items';
// Bump when a new handwritten inventory page is added so existing DBs re-run
// the inserter (it skips names already present in this category).
const NEWLY_ADDED_ITEMS_SETTING = 'newly_added_items_catalog_v20';
const NEWLY_ADDED_ITEMS_COUNT = 1592;
const NEWLY_ADDED_ITEMS_UNIT_PRICE_FIX = 'newly_added_items_unit_price_v1';
const NEWLY_ADDED_ITEMS_NOTEBOOK1_REMOVED = 'newly_added_items_notebook1_removed_v1';
const NEWLY_ADDED_ITEMS_RECOUNT_V1 = 'newly_added_items_recount_v9';
const PRODUCT_CATALOG_PATH = path.join(
  __dirname,
  '..',
  '..',
  'renderer',
  'assets',
  'product-catalog.json'
);
const LEGACY_WALK_IN = {
  id: 1,
  name: 'Walk-in Customer',
  type: 'walkin',
  phone: '',
  creditLimit: 0,
};
const LEGACY_DEMO_CUSTOMERS = [
  {
    id: 2,
    name: 'ABC Construction',
    type: 'contractor',
    phone: '0917 111 2222',
    creditLimit: 50000,
    originalBalances: [0, 12000],
  },
  {
    id: 3,
    name: 'Mendoza Builders',
    type: 'contractor',
    phone: '0918 333 4444',
    creditLimit: 80000,
    originalBalances: [0, 35000],
  },
  {
    id: 4,
    name: 'Rivera Contractors',
    type: 'contractor',
    phone: '0919 555 6666',
    creditLimit: 30000,
    originalBalances: [0, 8000],
  },
  {
    id: 5,
    name: 'Rivera Residence',
    type: 'walkin',
    phone: '0920 777 8888',
    creditLimit: 0,
    originalBalances: [0],
  },
];

function readProductCatalog() {
  return JSON.parse(fs.readFileSync(PRODUCT_CATALOG_PATH, 'utf8'));
}

function getNewlyAddedItems(catalog = readProductCatalog()) {
  const items = catalog.filter((item) =>
    String(item.category || '').trim().toLowerCase() === NEWLY_ADDED_ITEMS_CATEGORY.toLowerCase()
  );
  if (items.length !== NEWLY_ADDED_ITEMS_COUNT) {
    throw new Error(
      `Expected ${NEWLY_ADDED_ITEMS_COUNT} "${NEWLY_ADDED_ITEMS_CATEGORY}" catalog items; found ${items.length}`
    );
  }

  const names = new Set();
  const skus = new Set();
  for (const item of items) {
    const name = String(item.name || '').trim();
    const sku = String(item.sku || '').trim();
    const stock = Number(item.stock);
    const price = Number(item.price);
    const baseUnit = String(item.baseUnit || item.unit || '').trim();
    if (!name || !sku || !baseUnit || !Number.isFinite(stock) || stock < 0
      || !Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid "${NEWLY_ADDED_ITEMS_CATEGORY}" catalog entry: ${name || sku || '(unnamed)'}`);
    }
    const normalizedName = name.toLowerCase();
    const normalizedSku = sku.toLowerCase();
    if (names.has(normalizedName) || skus.has(normalizedSku)) {
      throw new Error(`Duplicate "${NEWLY_ADDED_ITEMS_CATEGORY}" catalog entry: ${name}`);
    }
    names.add(normalizedName);
    skus.add(normalizedSku);
  }
  return items;
}

function isRetiredNotebook1Sku(sku) {
  const match = /^NAI-(\d+)$/.exec(String(sku || ''));
  if (!match) return false;
  const number = Number(match[1]);
  return number >= 71 && number <= 215;
}

/**
 * Soft-delete notebook folder "1" inventory (NAI-071 through NAI-215)
 * from existing installs.
 */
function removeNotebook1NewlyAddedItems(db) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?')
    .get(NEWLY_ADDED_ITEMS_NOTEBOOK1_REMOVED);
  if (marker) return { removed: 0, alreadyRun: true };

  let removed = 0;
  db.transaction(() => {
    const rows = db.prepare('SELECT id, sku FROM products WHERE active=1').all()
      .filter((row) => isRetiredNotebook1Sku(row.sku));
    const soft = db.prepare('UPDATE products SET active=0 WHERE id=?');
    for (const row of rows) {
      soft.run(row.id);
      removed++;
    }
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_NOTEBOOK1_REMOVED, '1');
  })();
  return { removed, alreadyRun: false };
}

/**
 * Apply later notebook recounts to items already present under the same name.
 * Runs once even when the main catalog marker already applied.
 */
function applyNewlyAddedRecount(db) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(NEWLY_ADDED_ITEMS_RECOUNT_V1);
  if (marker) return { applied: false, alreadyRun: true };

  // v2.2.14 shipped 46 Newly Added Items. Only these five stock baselines
  // changed afterward; every later SKU is inserted from the current catalog.
  // Apply the baseline difference to live stock so sales, refunds, and manual
  // restocks made since installation remain intact.
  const fixes = [
    { sku: 'NAI-007', stockDelta: 10 },
    { sku: 'NAI-009', stockDelta: 36 },
    {
      sku: 'NAI-021',
      stockDelta: 18,
      oldPrice: 265,
      newPrice: 245,
      oldUnit: 'pcs',
    },
    { sku: 'NAI-037', stockDelta: 37 },
    { sku: 'NAI-045', stockDelta: 1 },
  ];

  let updated = 0;
  db.transaction(() => {
    const find = db.prepare('SELECT id FROM products WHERE sku=? AND active=1');
    const addStock = db.prepare('UPDATE products SET stock=stock+? WHERE id=?');
    const updateProductPrice = db.prepare(
      'UPDATE products SET price=? WHERE id=? AND base_unit=? AND price=?'
    );
    const updateUnitPrice = db.prepare(
      'UPDATE product_units SET price=? WHERE product_id=? AND unit=? AND factor=1 AND price=?'
    );
    const move = db.prepare(
      'INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,NULL)'
    );
    for (const fix of fixes) {
      const row = find.get(fix.sku);
      if (!row) continue;
      addStock.run(fix.stockDelta, row.id);
      if (fix.oldPrice != null) {
        updateProductPrice.run(fix.newPrice, row.id, fix.oldUnit, fix.oldPrice);
        updateUnitPrice.run(fix.newPrice, row.id, fix.oldUnit, fix.oldPrice);
      }
      move.run(
        row.id,
        'adjustment',
        fix.stockDelta,
        'Newly Added Items catalog stock correction'
      );
      updated++;
    }
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_RECOUNT_V1, '1');
  })();
  return { applied: updated > 0, alreadyRun: false, updated };
}

/**
 * Convert pack-priced fasteners / tox to ₱1 per piece with piece-level stock.
 * Runs once even when the main catalog marker already applied.
 */
function applyNewlyAddedUnitPriceFix(db) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(NEWLY_ADDED_ITEMS_UNIT_PRICE_FIX);
  if (marker) return { applied: false, alreadyRun: true };

  const fixes = [
    { sku: 'NAI-207', name: 'Tox 1.00', stock: 0, price: 1 },
    { sku: 'NAI-208', name: 'Blackscrew Wood', stock: 800, price: 1 },
    { sku: 'NAI-209', name: 'Blackscrew Wood 1 1/2', stock: 3000, price: 1 },
    { sku: 'NAI-210', name: 'Black Screw Wood 2', stock: 1000, price: 1 },
    { sku: 'NAI-211', name: 'Blackscrew 1 Metal', stock: 600, price: 1 },
    { sku: 'NAI-212', name: 'Blackscrew 1 1/2 Metal', stock: 700, price: 1 },
    { sku: 'NAI-213', name: 'Fanhead', stock: 700, price: 1 },
    { sku: 'NAI-214', name: 'Blackscrew Metal 2', stock: 700, price: 1 },
    { sku: 'NAI-215', name: 'Hardscrew 3/4', stock: 600, price: 1 },
  ];

  let updated = 0;
  db.transaction(() => {
    const find = db.prepare('SELECT id, stock FROM products WHERE sku=? AND active=1');
    const upd = db.prepare(
      'UPDATE products SET name=?, stock=?, price=?, base_unit=? WHERE id=?'
    );
    const delUnits = db.prepare('DELETE FROM product_units WHERE product_id=?');
    const insUnit = db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
    );
    const insMovement = db.prepare(
      'INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,NULL)'
    );

    for (const fix of fixes) {
      const row = find.get(fix.sku);
      if (!row) continue;
      const previousStock = Number(row.stock) || 0;
      upd.run(fix.name, fix.stock, fix.price, 'pcs', row.id);
      delUnits.run(row.id);
      insUnit.run(row.id, 'pcs', 1, fix.price);
      const delta = fix.stock - previousStock;
      if (delta !== 0) {
        insMovement.run(
          row.id,
          delta > 0 ? 'restock' : 'adjustment',
          delta,
          'Unit price fix: sell per piece at ₱1'
        );
      }
      updated++;
    }

    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_UNIT_PRICE_FIX, '1');
  })();

  return { applied: true, alreadyRun: false, updated };
}

/**
 * Add the handwritten inventory batches to an existing database exactly once.
 *
 * Existing names are preserved rather than overwritten, and the settings
 * marker prevents later user edits or deletions from being undone at startup.
 */
function ensureNewlyAddedItems(db) {
  removeNotebook1NewlyAddedItems(db);
  applyNewlyAddedUnitPriceFix(db);
  applyNewlyAddedRecount(db);

  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(NEWLY_ADDED_ITEMS_SETTING);
  if (marker) return { inserted: 0, skipped: 0, alreadyRun: true };

  const items = getNewlyAddedItems();
  let inserted = 0;
  let categoryId = null;

  db.transaction(() => {
    let category = db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE')
      .get(NEWLY_ADDED_ITEMS_CATEGORY);
    if (!category) {
      const sort = Number(db.prepare('SELECT COALESCE(MAX(sort),0) AS value FROM categories').get().value) + 1;
      db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)')
        .run(NEWLY_ADDED_ITEMS_CATEGORY, sort);
      category = db.prepare('SELECT id FROM categories WHERE name=?').get(NEWLY_ADDED_ITEMS_CATEGORY);
    }
    categoryId = category.id;

    // Preserve administrator-deactivated products across catalog-marker bumps.
    // Only rows retired by the notebook cleanup may be ignored so a genuinely
    // current catalog item with the same name can still be inserted.
    const findNames = db.prepare(
      'SELECT id,sku,active FROM products WHERE category_id=? AND TRIM(name)=? COLLATE NOCASE'
    );
    // SKUs are unique across active and inactive rows — always avoid collisions.
    const findSku = db.prepare('SELECT id,category_id FROM products WHERE sku=?');
    const insertProduct = db.prepare(
      `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
       VALUES(?,?,?,?,?,?,?,10,0,1)`
    );
    const insertUnit = db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
    );
    const insertMovement = db.prepare(
      'INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,NULL)'
    );

    for (const item of items) {
      const name = String(item.name).trim();
      const preferredSku = String(item.sku).trim();
      const sameSkuRow = findSku.get(preferredSku);
      // SKU is the stable identity when an administrator has renamed or
      // deactivated an item. Do not recreate its former catalog name during
      // a later marker bump.
      if (sameSkuRow && Number(sameSkuRow.category_id) === Number(categoryId)) continue;

      const sameNameRows = findNames.all(categoryId, name);
      const hasBlockingName = sameNameRows.some(
        (row) => Number(row.active) !== 0 || !isRetiredNotebook1Sku(row.sku)
      );
      if (hasBlockingName) continue;

      let sku = preferredSku;
      let suffix = 2;
      while (findSku.get(sku)) {
        sku = `${preferredSku}-${suffix}`;
        suffix++;
      }

      const baseUnit = String(item.baseUnit || item.unit).trim();
      const stock = Number(item.stock);
      const price = Number(item.price);
      const productId = insertProduct
        .run(sku, name, categoryId, baseUnit, stock, 0, price)
        .lastInsertRowid;
      const units = Array.isArray(item.units) && item.units.length
        ? item.units
        : [{ unit: baseUnit, factor: 1, price }];
      for (const unit of units) {
        insertUnit.run(
          productId,
          String(unit.unit || baseUnit).trim(),
          Number(unit.factor) || 1,
          Number(unit.price) || price
        );
      }
      if (stock > 0) {
        insertMovement.run(productId, 'restock', stock, 'Initial stock (Newly Added Items)');
      }
      inserted++;
    }

    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_SETTING, '1');
  })();

  return {
    inserted,
    skipped: items.length - inserted,
    alreadyRun: false,
    categoryId,
  };
}

function amountMatches(value, expected) {
  const amount = Number(value);
  return Number.isFinite(amount) && expected.some((candidate) => Math.abs(amount - candidate) < 0.005);
}

function createPreCleanupSnapshot(db) {
  if (!db.filePath || !fs.existsSync(db.filePath)) return { path: null, error: null };
  let recoveryDb = null;
  try {
    // Flush first so the snapshot includes every schema migration that ran
    // before this cleanup. Unlike the shim's internal flush, this call throws.
    db.flush();
    const parsed = path.parse(db.filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(parsed.dir, `${parsed.name}.pre-demo-customer-cleanup.${stamp}${parsed.ext || '.sqlite'}`);

    // Stamp only the recovery copy as already processed. If an administrator
    // restores it, startup must keep the recovered examples instead of
    // immediately applying the same destructive migration again.
    const RawDatabase = db._raw && db._raw.constructor;
    if (typeof RawDatabase !== 'function') throw new Error('SQLite recovery snapshot is unavailable');
    recoveryDb = new RawDatabase(fs.readFileSync(db.filePath));
    recoveryDb.run(
      'INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)',
      [LEGACY_DEMO_CLEANUP_SETTING, '1']
    );
    fs.writeFileSync(snapshotPath, Buffer.from(recoveryDb.export()), { flag: 'wx' });
    return { path: snapshotPath, error: null };
  } catch (error) {
    return { path: null, error: error.message };
  } finally {
    if (recoveryDb) {
      try { recoveryDb.close(); } catch {}
    }
  }
}

function runCleanupMutation(db, run, transactional) {
  if (!transactional) {
    run();
    return null;
  }
  db.transaction(run)();
  try {
    // Explicitly verify durable persistence before reporting completion.
    db.flush();
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * Remove untouched customer examples shipped by early YANKENT releases.
 *
 * Provenance requires the complete original id/timestamp cohort, not merely
 * mutable profile fields. Rows with durable sales, payments, edited profile
 * fields, or non-synthetic Loan activity are preserved. A settings marker
 * makes this a one-time cleanup so a client can later reuse any example name.
 */
function removeLegacyDemoCustomers(db, { transactional = true, snapshot = true } = {}) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(LEGACY_DEMO_CLEANUP_SETTING);
  if (marker) {
    return { removed: 0, preserved: 0, alreadyRun: true, backupPath: null, persisted: true };
  }

  const findCustomer = db.prepare(`SELECT * FROM customers
    WHERE id=? AND name=? AND type=? AND COALESCE(phone,'')=?
      AND ABS(COALESCE(credit_limit,0)-?) < 0.005`);
  const walkIn = findCustomer.get(
    LEGACY_WALK_IN.id,
    LEGACY_WALK_IN.name,
    LEGACY_WALK_IN.type,
    LEGACY_WALK_IN.phone,
    LEGACY_WALK_IN.creditLimit
  );
  const cohort = LEGACY_DEMO_CUSTOMERS.map((example) => ({
    example,
    customer: findCustomer.get(example.id, example.name, example.type, example.phone, example.creditLimit),
  }));
  const hasOriginalSeedProvenance = !!walkIn && cohort.every(({ customer }) =>
    customer && customer.created_at === walkIn.created_at
  );
  if (!hasOriginalSeedProvenance) {
    const mark = () => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(LEGACY_DEMO_CLEANUP_SETTING, '1');
    const persistenceError = runCleanupMutation(db, mark, transactional);
    return {
      removed: 0,
      preserved: 0,
      alreadyRun: false,
      backupPath: null,
      persisted: transactional ? !persistenceError : null,
      persistenceError,
    };
  }

  const durableSaleCount = db.prepare(`SELECT COUNT(*) AS count FROM sales
    WHERE customer_id=? AND COALESCE(status,'')!='pending'`);
  const pendingSales = db.prepare("SELECT id FROM sales WHERE customer_id=? AND status='pending'");
  const customerLoans = db.prepare('SELECT * FROM loans WHERE customer_id=?');
  const paymentCount = db.prepare('SELECT COUNT(*) AS count FROM loan_payments WHERE customer_id=?');
  const changedEventCount = db.prepare(`SELECT COUNT(*) AS count FROM loan_events
    WHERE customer_id=? AND event_type!='legacy_created'`);

  const removable = [];
  let preserved = 0;
  for (const { example, customer } of cohort) {
    const profileWasEdited = customer.entity_kind !== 'individual'
      || ['contact_person', 'email', 'address', 'notes'].some((field) => String(customer[field] || '').trim())
      || Number(customer.active) !== 1;
    const balanceIsOriginal = amountMatches(customer.credit_used, example.originalBalances);
    const hasDurableSales = Number(durableSaleCount.get(customer.id).count) > 0;
    const loans = customerLoans.all(customer.id);
    const hasPayments = Number(paymentCount.get(customer.id).count) > 0;
    const hasChangedEvents = Number(changedEventCount.get(customer.id).count) > 0;
    const loansAreSynthetic = loans.every((loan) => loan.source === 'legacy'
      && loan.sale_id == null
      && loan.state === 'open'
      && !String(loan.due_date || '').trim()
      && amountMatches(loan.principal, example.originalBalances)
      && amountMatches(loan.balance, example.originalBalances)
      && Math.abs(Number(loan.principal) - Number(loan.balance)) < 0.005);

    if (profileWasEdited || !balanceIsOriginal || hasDurableSales || hasPayments || hasChangedEvents || !loansAreSynthetic) {
      preserved++;
    } else {
      removable.push({
        customer,
        loans,
        pendingSaleIds: pendingSales.all(customer.id).map((sale) => sale.id),
      });
    }
  }

  let backupPath = null;
  if (snapshot && removable.length) {
    const backup = createPreCleanupSnapshot(db);
    if (backup.error) {
      return {
        removed: 0,
        preserved,
        alreadyRun: false,
        backupPath: null,
        persisted: false,
        snapshotError: backup.error,
      };
    }
    backupPath = backup.path;
  }

  // sql.js export (used by the snapshot above) invalidates prepared
  // statements, so every write statement is deliberately prepared afterward.
  const deletePendingItems = db.prepare('DELETE FROM sale_items WHERE sale_id=?');
  const deletePendingSale = db.prepare("DELETE FROM sales WHERE id=? AND status='pending'");
  const deleteReminders = db.prepare('DELETE FROM loan_reminders WHERE loan_id=?');
  const deleteEvents = db.prepare('DELETE FROM loan_events WHERE loan_id=?');
  const deleteLoans = db.prepare('DELETE FROM loans WHERE customer_id=?');
  const deleteCustomer = db.prepare('DELETE FROM customers WHERE id=?');
  const markComplete = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  const run = () => {
    for (const { customer, loans, pendingSaleIds } of removable) {
      for (const saleId of pendingSaleIds) {
        deletePendingItems.run(saleId);
        deletePendingSale.run(saleId);
      }
      for (const loan of loans) {
        deleteReminders.run(loan.id);
        deleteEvents.run(loan.id);
      }
      deleteLoans.run(customer.id);
      deleteCustomer.run(customer.id);
    }
    markComplete.run(LEGACY_DEMO_CLEANUP_SETTING, '1');
  };

  const persistenceError = runCleanupMutation(db, run, transactional);
  return {
    removed: removable.length,
    preserved,
    alreadyRun: false,
    backupPath,
    persisted: transactional ? !persistenceError : null,
    persistenceError,
  };
}

/**
 * Seed initial data: users, walk-in customer, and the construction-supply
 * product catalog. Existing databases receive one-time catalog additions.
 */
function seedDatabase(db) {
  const { hashPassword } = require('../lib/auth');

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) {
    ensureNewlyAddedItems(db);
    return false;
  }

  const items = readProductCatalog();
  getNewlyAddedItems(items);

  const tx = db.transaction(() => {
    // ---- Users -----------------------------------------------------------
    const insUser = db.prepare(
      'INSERT INTO users(username, password_hash, full_name, role, active) VALUES(?,?,?,?,1)'
    );
    insUser.run('admin', hashPassword('admin123'), 'YANKENT Admin', 'admin');
    insUser.run('cashier', hashPassword('cashier123'), 'Maria Santos', 'cashier');

    // ---- Customers / contractor accounts --------------------------------
    const insCust = db.prepare(
      'INSERT INTO customers(name, type, phone, credit_limit, credit_used) VALUES(?,?,?,?,?)'
    );
    insCust.run('Walk-in Customer', 'walkin', '', 0, 0);

    // ---- Products from product-catalog.json ------------------------------
    const insCat = db.prepare('INSERT OR IGNORE INTO categories(name, sort) VALUES(?, ?)');
    const catIdStmt = db.prepare('SELECT id FROM categories WHERE name=?');
    const maxSortStmt = db.prepare('SELECT COALESCE(MAX(sort),0) AS s FROM categories');
    const insProd = db.prepare(
      `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
       VALUES(?,?,?,?,?,?,?,10,0,1)`
    );
    const insUnit = db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
    );
    const insMovement = db.prepare(
      'INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,NULL)'
    );
    const counterStmt = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM products');

    const catCache = {};
    const getCatId = (name) => {
      if (catCache[name] != null) return catCache[name];
      let row = catIdStmt.get(name);
      if (!row) {
        const sort = maxSortStmt.get().s + 1;
        insCat.run(name, sort);
        row = catIdStmt.get(name);
      }
      catCache[name] = row.id;
      return row.id;
    };

    for (const it of items) {
      const name = String(it.name || '').trim();
      if (!name) continue;
      const catName = String(it.category || 'Uncategorized').trim();
      const catId = getCatId(catName);
      const base = String(it.baseUnit || it.unit || 'pc').trim();
      const stock = Number(it.stock) || 0;
      const price = Number(it.price) || 0;
      const n = counterStmt.get().n;
      const sku = it.sku || ('P-' + String(n).padStart(5, '0'));
      const pid = insProd.run(sku, name, catId, base, stock, 0, price).lastInsertRowid;
      const units = Array.isArray(it.units) && it.units.length ? it.units : [{ unit: base, factor: 1, price }];
      for (const u of units) {
        insUnit.run(pid, String(u.unit || base), Number(u.factor) || 1, Number(u.price) || price);
      }
      if (stock > 0) {
        insMovement.run(pid, 'restock', stock, 'Initial stock (catalog)');
      }
    }

    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_SETTING, '1');
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_UNIT_PRICE_FIX, '1');
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_NOTEBOOK1_REMOVED, '1');
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .run(NEWLY_ADDED_ITEMS_RECOUNT_V1, '1');
  });

  tx();
  return true;
}

module.exports = {
  seedDatabase,
  ensureNewlyAddedItems,
  removeLegacyDemoCustomers,
  LEGACY_DEMO_CLEANUP_SETTING,
  NEWLY_ADDED_ITEMS_CATEGORY,
  NEWLY_ADDED_ITEMS_SETTING,
  NEWLY_ADDED_ITEMS_COUNT,
  NEWLY_ADDED_ITEMS_UNIT_PRICE_FIX,
  NEWLY_ADDED_ITEMS_NOTEBOOK1_REMOVED,
  NEWLY_ADDED_ITEMS_RECOUNT_V1,
};
