'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = { seedDatabase };