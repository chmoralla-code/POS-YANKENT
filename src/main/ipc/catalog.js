'use strict';

/** Products, categories, product units, customers. */

function register(ipcMain, ctx) {
  const { db, guard } = ctx;

  // ---- Categories --------------------------------------------------------
  guard(ipcMain, 'pos:categories:list', { auth: true }, () =>
    db.prepare('SELECT * FROM categories ORDER BY sort, name').all()
  );

  guard(ipcMain, 'pos:categories:create', { admin: true }, (_c, name) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('Category name is required');
    const ex = db.prepare('SELECT id FROM categories WHERE name=?').get(n);
    if (ex) throw new Error('Category already exists');
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) AS s FROM categories').get().s;
    return { id: db.prepare('INSERT INTO categories(name, sort) VALUES(?,?)').run(n, maxSort + 1).lastInsertRowid };
  });

  guard(ipcMain, 'pos:categories:update', { admin: true }, (_c, id, name) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('Category name is required');
    const ex = db.prepare('SELECT id FROM categories WHERE name=? AND id!=?').get(n, id);
    if (ex) throw new Error('Category name already in use');
    db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, id);
    return true;
  });

  guard(ipcMain, 'pos:categories:delete', { admin: true }, (_c, id) => {
    // Products in this category get category_id = NULL (SET NULL in schema)
    db.prepare('DELETE FROM categories WHERE id=?').run(id);
    return true;
  });

  guard(ipcMain, 'pos:categories:withCounts', { auth: true }, () => {
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort, name').all();
    const counts = db.prepare('SELECT category_id, COUNT(*) AS c FROM products WHERE active=1 GROUP BY category_id').all();
    const map = {}; counts.forEach((r) => (map[r.category_id] = r.c));
    return cats.map((c) => ({ ...c, productCount: map[c.id] || 0 }));
  });

  // ---- Customers ---------------------------------------------------------
  guard(ipcMain, 'pos:customers:list', { auth: true }, () =>
    db.prepare('SELECT * FROM customers ORDER BY id').all()
  );

  guard(ipcMain, 'pos:customers:create', { admin: true }, (_c, c) => {
    const info = db.prepare(
      'INSERT INTO customers(name,type,phone,credit_limit,credit_used) VALUES(?,?,?,?,0)'
    ).run(c.name, c.type || 'walkin', c.phone || '', c.credit_limit || 0);
    return { id: info.lastInsertRowid };
  });

  guard(ipcMain, 'pos:customers:update', { admin: true }, (_c, id, c) => {
    db.prepare('UPDATE customers SET name=?, type=?, phone=?, credit_limit=? WHERE id=?')
      .run(c.name, c.type, c.phone || '', c.credit_limit || 0, id);
    return true;
  });

  // ---- Products ----------------------------------------------------------
  // List with the default (first) unit price and stock for the catalog grid.
  guard(ipcMain, 'pos:products:list', { auth: true }, (_c, filter = {}) => {
    let sql = `
      SELECT p.id, p.sku, p.name, p.base_unit, p.stock, p.price, p.cost,
             p.low_stock_threshold AS low, p.is_service, p.active,
             c.name AS category
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.active = 1`;
    const params = [];
    if (filter.includeServices === false) sql += ` AND p.is_service = 0`;
    if (filter.categoryId) { sql += ` AND p.category_id = ?`; params.push(filter.categoryId); }
    if (filter.q) {
      sql += ` AND (LOWER(p.sku) LIKE ? OR LOWER(p.name) LIKE ?)`;
      const q = '%' + String(filter.q).toLowerCase() + '%';
      params.push(q, q);
    }
    sql += ` ORDER BY p.is_service, p.name`;
    const rows = db.prepare(sql).all(...params);
    // attach sellable units
    const unitsStmt = db.prepare('SELECT unit, factor, price FROM product_units WHERE product_id=? ORDER BY id');
    for (const r of rows) r.units = unitsStmt.all(r.id);
    return rows;
  });

  guard(ipcMain, 'pos:products:get', { auth: true }, (_c, id) => {
    const p = db.prepare(`
      SELECT p.*, c.name AS category FROM products p
      LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?`).get(id);
    if (!p) return null;
    p.units = db.prepare('SELECT id, unit, factor, price FROM product_units WHERE product_id=? ORDER BY id').all(id);
    return p;
  });

  guard(ipcMain, 'pos:products:create', { admin: true }, (_c, p) => {
    if (!p.name) throw new Error('Name is required');
    const info = db.transaction(() => {
      // Auto-generate an internal code (SKU) if not provided — never shown to users.
      let sku = p.sku && String(p.sku).trim();
      if (!sku) {
        const n = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM products').get().n;
        sku = 'P-' + String(n).padStart(5, '0');
      }
      const r = db.prepare(
        `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
          VALUES(?,?,?,?,?,?,?,?,?,1)`
      ).run(sku, p.name, p.category_id || null, p.base_unit || 'pc', p.stock || 0, p.cost || 0, p.price || 0, p.low_stock_threshold ?? 10, p.is_service ? 1 : 0);
      const pid = r.lastInsertRowid;
      const ins = db.prepare('INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)');
      if (Array.isArray(p.units) && p.units.length) {
        for (const u of p.units) ins.run(pid, u.unit, u.factor, u.price);
      } else {
        ins.run(pid, p.base_unit || 'pc', 1, p.price || 0);
      }
      // record initial stock as a restock movement
      if ((p.stock || 0) !== 0) {
        db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)')
          .run(pid, 'restock', p.stock, 'Initial stock', _c.session?.id || null);
      }
      return pid;
    })();
    return { id: info };
  });

  guard(ipcMain, 'pos:products:update', { admin: true }, (_c, id, p) => {
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET sku=?, name=?, category_id=?, base_unit=?, cost=?, price=?,
           low_stock_threshold=?, is_service=?, active=? WHERE id=?`
      ).run(p.sku, p.name, p.category_id || null, p.base_unit, p.cost || 0, p.price || 0, p.low_stock_threshold ?? 10, p.is_service ? 1 : 0, p.active ? 1 : 0, id);
      if (Array.isArray(p.units)) {
        db.prepare('DELETE FROM product_units WHERE product_id=?').run(id);
        const ins = db.prepare('INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)');
        for (const u of p.units) ins.run(id, u.unit, u.factor, u.price);
      }
    })();
    return true;
  });

  // Stock adjustment (admin). Sets absolute new stock and logs the delta.
  guard(ipcMain, 'pos:products:setStock', { admin: true }, (_c, id, newStock, reason) => {
    const row = db.prepare('SELECT stock, is_service FROM products WHERE id=?').get(id);
    if (!row) throw new Error('Product not found');
    if (row.is_service) throw new Error('Cannot set stock for a service');
    const delta = Number(newStock) - row.stock;
    db.transaction(() => {
      db.prepare('UPDATE products SET stock=? WHERE id=?').run(newStock, id);
      db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)')
        .run(id, 'adjustment', delta, reason || 'Stock count', _c.session?.id || null);
    })();
    return { stock: Number(newStock), delta };
  });

  guard(ipcMain, 'pos:products:movements', { admin: true }, (_c, id) =>
    db.prepare('SELECT * FROM stock_movements WHERE product_id=? ORDER BY datetime DESC LIMIT 50').all(id)
  );

  guard(ipcMain, 'pos:products:delete', { admin: true }, (_c, id) => {
    // Soft-delete: deactivate so historical sales keep their references.
    db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
    return true;
  });
}

module.exports = { register };
