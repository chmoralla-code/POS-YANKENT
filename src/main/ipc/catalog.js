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
      SELECT p.id, p.sku, p.name, p.category_id, p.base_unit, p.stock, p.price, p.cost,
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
      // Preserve active status unless explicitly set. The Edit form never sends
      // `active`, so defaulting it to 0 would silently soft-delete the product
      // every time it is edited — it then vanishes from the catalog (which only
      // lists active=1). Deactivation is the Del button's job, not Edit's.
      const existing = db.prepare('SELECT active FROM products WHERE id=?').get(id);
      const active = (p.active === undefined || p.active === null)
        ? (existing ? existing.active : 1)
        : (p.active ? 1 : 0);
      db.prepare(
        `UPDATE products SET sku=?, name=?, category_id=?, base_unit=?, cost=?, price=?,
           low_stock_threshold=?, is_service=?, active=? WHERE id=?`
      ).run(p.sku, p.name, p.category_id || null, p.base_unit, p.cost || 0, p.price || 0, p.low_stock_threshold ?? 10, p.is_service ? 1 : 0, active, id);
      if (Array.isArray(p.units)) {
        db.prepare('DELETE FROM product_units WHERE product_id=?').run(id);
        const ins = db.prepare('INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)');
        for (const u of p.units) ins.run(id, u.unit, u.factor, u.price);
      }
    })();
    return true;
  });

  // Stock adjustment (admin). Sets absolute new stock and logs the delta.
  guard(ipcMain, 'pos:products:setStock', { admin: true }, (_c, id, newStock, reason, date, location) => {
    const row = db.prepare('SELECT stock, is_service FROM products WHERE id=?').get(id);
    if (!row) throw new Error('Product not found');
    if (row.is_service) throw new Error('Cannot set stock for a service');
    const delta = Number(newStock) - row.stock;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const dt = date ? `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` : localNow;
    db.transaction(() => {
      db.prepare('UPDATE products SET stock=? WHERE id=?').run(newStock, id);
      db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id,datetime,source_location) VALUES(?,?,?,?,?,?,?)')
        .run(id, 'adjustment', delta, reason || 'Stock count', _c.session?.id || null, dt, location || null);
    })();
    return { stock: Number(newStock), delta };
  });

  guard(ipcMain, 'pos:products:movements', { admin: true }, (_c, id) =>
    db.prepare('SELECT * FROM stock_movements WHERE product_id=? ORDER BY datetime DESC LIMIT 50').all(id)
  );

  // ---- Restock history (Restock History report) ------------------------
  // Every time new stock is added to a product — via the "Adjust Stock"
  // modal (delta > 0) or initial stock on product creation — a row is
  // written to stock_movements with a positive qty_change.  This endpoint
  // returns those restocks joined with product + user details so the
  // admin can see when each product was restocked and by whom.
  guard(ipcMain, 'pos:reports:stockDeliveries', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT sm.id, sm.product_id, sm.qty_change, sm.movement, sm.reason, sm.datetime, sm.source_location,
        p.sku, p.name, p.base_unit, p.category_id,
        c.name AS category_name,
        u.username, u.full_name AS user_name
      FROM stock_movements sm
      LEFT JOIN products p ON sm.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN users u ON sm.user_id = u.id
      WHERE sm.qty_change > 0`;
    const params = [];
    if (f.from) { sql += ` AND sm.datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND sm.datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    if (f.productId) { sql += ` AND sm.product_id = ?`; params.push(f.productId); }
    if (f.q) {
      sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR sm.reason LIKE ? OR sm.source_location LIKE ? OR u.full_name LIKE ?)`;
      const like = '%' + f.q + '%';
      params.push(like, like, like, like, like);
    }
    sql += ` ORDER BY sm.datetime DESC LIMIT ?`;
    params.push(Math.min(f.limit || 500, 2000));
    return db.prepare(sql).all(...params);
  });

  // Summary stats for the restock history header.
  guard(ipcMain, 'pos:reports:stockDeliverySummary', { auth: true }, (_c, f = {}) => {
    const base = `FROM stock_movements sm WHERE sm.qty_change > 0`;
    const conds = [];
    const params = [];
    if (f.from) { conds.push('sm.datetime >= ?'); params.push(f.from + ' 00:00:00'); }
    if (f.to) { conds.push('sm.datetime <= ?'); params.push(f.to + ' 23:59:59'); }
    const where = conds.length ? ' AND ' + conds.join(' AND ') : '';
    const totals = db.prepare(`SELECT COUNT(*) AS tx, COALESCE(SUM(sm.qty_change),0) AS units ${base}${where}`).get(...params);
    const products = db.prepare(`SELECT COUNT(DISTINCT sm.product_id) AS c ${base}${where}`).get(...params);
    // Top restocked product in the range
    const top = db.prepare(`SELECT p.name, SUM(sm.qty_change) AS qty FROM stock_movements sm LEFT JOIN products p ON sm.product_id=p.id WHERE sm.qty_change > 0${where} GROUP BY sm.product_id ORDER BY qty DESC LIMIT 1`).get(...params);
    return { totals, products: products.c, top };
  });

  guard(ipcMain, 'pos:products:delete', { admin: true }, (_c, id) => {
    // Soft-delete: deactivate so historical sales keep their references.
    db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
    return true;
  });

  // Delete all products (admin). Preserves categories. Products are soft-deleted
  // (active=0) so historical sale_items keep valid references; their sellable
  // units and stock movements are wiped. Returns counts.
  guard(ipcMain, 'pos:products:deleteAll', { admin: true }, () => {
    const counts = db.transaction(() => {
      const ids = db.prepare('SELECT id FROM products').all().map((r) => r.id);
      if (!ids.length) return { products: 0, units: 0, movements: 0 };
      const placeholders = ids.map(() => '?').join(',');
      const units = db.prepare(`SELECT COUNT(*) AS c FROM product_units WHERE product_id IN (${placeholders})`).get(...ids).c;
      const movements = db.prepare(`SELECT COUNT(*) AS c FROM stock_movements WHERE product_id IN (${placeholders})`).get(...ids).c;
      db.prepare(`DELETE FROM product_units WHERE product_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM stock_movements WHERE product_id IN (${placeholders})`).run(...ids);
      db.prepare('UPDATE products SET active=0').run();
      // Reset the product autoincrement counter so new products start at id 1.
      db.prepare("DELETE FROM sqlite_sequence WHERE name='products'").run();
      return { products: ids.length, units, movements };
    })();
    return counts;
  });

  // Bulk import products (admin). Accepts an array of:
  //   { name, category, baseUnit, stock, price, units: [{unit, factor, price}] }
  // Categories are created if missing. Existing product names are skipped.
  // Returns { imported, skipped, categories }.
  guard(ipcMain, 'pos:products:bulkImport', { admin: true }, (_c, items) => {
    if (!Array.isArray(items)) throw new Error('Expected an array of products');
    const result = db.transaction(() => {
      const insCat = db.prepare('INSERT OR IGNORE INTO categories(name, sort) VALUES (?, ?)');
      const catIdStmt = db.prepare('SELECT id FROM categories WHERE name=?');
      const maxSortStmt = db.prepare('SELECT COALESCE(MAX(sort),0) AS s FROM categories');
      const insProd = db.prepare(
        `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
         VALUES(?,?,?,?,?,?,?,10,0,1)`
      );
      const findByName = db.prepare('SELECT id FROM products WHERE name=? AND active=1');
      const insUnit = db.prepare('INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)');
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

      let imported = 0, skipped = 0;
      const newCats = new Set();
      for (const it of items) {
        const name = String(it.name || '').trim();
        if (!name) { skipped++; continue; }
        if (findByName.get(name)) { skipped++; continue; }
        const catName = String(it.category || 'Uncategorized').trim();
        const catId = getCatId(catName);
        newCats.add(catName);
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
        imported++;
      }
      return { imported, skipped, categories: Array.from(newCats) };
    })();
    return result;
  });
}

module.exports = { register };
