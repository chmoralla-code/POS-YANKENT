'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_DEMO_CLEANUP_SETTING = 'legacy_demo_customers_removed_v1';
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
 * Seed initial data: users, walk-in customer, and the 135-item
 * construction-supply product catalog from product-catalog.json.
 * Idempotent: only runs when the database is empty.
 */
function seedDatabase(db) {
  const { hashPassword } = require('../lib/auth');

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return false; // already seeded

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
    const catalogPath = path.join(__dirname, '..', '..', 'renderer', 'assets', 'product-catalog.json');
    const items = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

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
    }
  });

  tx();
  return true;
}

module.exports = { seedDatabase, removeLegacyDemoCustomers, LEGACY_DEMO_CLEANUP_SETTING };
