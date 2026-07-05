'use strict';
/* Test helpers for YANKENT POS — creates a fresh temp SQLite DB (sql.js) with schema + seed. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, ensureSettings } = require('../src/main/db');
const { seedDatabase } = require('../src/main/db/seed');

async function freshDb() {
  const p = path.join(os.tmpdir(), `yankent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = await openDatabase(p);
  ensureSettings(db);
  seedDatabase(db);
  insertTestFixtures(db);
  const close = () => {
    try { db.close(); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + ext); } catch {} }
  };
  return { db, path: p, close };
}

/**
 * Insert well-known products + a contractor customer that the test suite
 * references by SKU/name.  These live only in the throwaway test DB — the
 * production seed uses product-catalog.json and does NOT include these.
 */
function insertTestFixtures(db) {
  const tx = db.transaction(() => {
    // Categories the test products belong to
    const catCement = db.prepare('INSERT OR IGNORE INTO categories(name, sort) VALUES(?,?)')
      .run('Cement', 0).lastInsertRowid
      || db.prepare('SELECT id FROM categories WHERE name=?').get('Cement').id;
    const catFasteners = db.prepare('INSERT OR IGNORE INTO categories(name, sort) VALUES(?,?)')
      .run('Fasteners', 1).lastInsertRowid
      || db.prepare('SELECT id FROM categories WHERE name=?').get('Fasteners').id;
    const catServices = db.prepare('INSERT OR IGNORE INTO categories(name, sort) VALUES(?,?)')
      .run('Services', 2).lastInsertRowid
      || db.prepare('SELECT id FROM categories WHERE name=?').get('Services').id;

    // Test products with known stock/price for sales/receipt/telegram tests
    const insProd = db.prepare(
      `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
       VALUES(?,?,?,?,?,?,?,10,?,1)`
    );
    const insUnit = db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
    );

    const cement = insProd.run('CMT-001', 'Portland Cement 40kg', catCement, 'bag', 120, 235, 280, 0).lastInsertRowid;
    insUnit.run(cement, 'bag', 1, 280);
    insUnit.run(cement, 'sack(50kg)', 1.25, 350);

    const nails = insProd.run('NIL-2', 'Common Nails 2" (per kg)', catFasteners, 'kg', 120, 78, 95, 0).lastInsertRowid;
    insUnit.run(nails, 'kg', 1, 95);
    insUnit.run(nails, '250g', 0.25, 28);
    insUnit.run(nails, 'box(5kg)', 5, 450);

    const cut = insProd.run('SVC-CUT', 'Wood Cutting Service', catServices, 'per cut', 0, 0, 25, 1).lastInsertRowid;
    insUnit.run(cut, 'per cut', 1, 25);

    // Contractor customer used by sales tests
    db.prepare('INSERT OR IGNORE INTO customers(name,type,phone,credit_limit,credit_used) VALUES(?,?,?,?,?)')
      .run('ABC Construction', 'contractor', '0917 111 2222', 50000, 12000);
  });
  tx();
}

module.exports = { freshDb };