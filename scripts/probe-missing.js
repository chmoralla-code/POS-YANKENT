'use strict';
// Diagnostic probe — find products that exist in the DB but may be hidden from lists.
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

(async () => {
  const SQL = await initSqlJs();
  const dbPath = path.resolve(__dirname, '..', 'data', 'yankent.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found at', dbPath);
    process.exit(1);
  }
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const q = process.argv[2] || '3M';
  const like = '%' + q + '%';

  console.log('=== Products matching "' + q + '" ===');
  const stmt = db.prepare(
    'SELECT id, sku, name, category_id, base_unit, stock, price, cost, low_stock_threshold, is_service, active FROM products WHERE name LIKE ? OR sku LIKE ? ORDER BY name'
  );
  stmt.bind([like, like]);
  while (stmt.step()) {
    const r = stmt.getAsObject();
    console.log(JSON.stringify(r));
  }
  stmt.free();

  console.log('\n=== Totals ===');
  const totals = db.exec(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN active=0 THEN 1 ELSE 0 END) AS inactive, SUM(CASE WHEN category_id IS NULL AND active=1 THEN 1 ELSE 0 END) AS active_no_category FROM products"
  );
  console.log(JSON.stringify(totals, null, 2));

  console.log('\n=== Active products with NULL category_id (visible only under "All") ===');
  const nc = db.prepare(
    'SELECT id, sku, name, category_id, active FROM products WHERE active=1 AND category_id IS NULL ORDER BY name'
  );
  let count = 0;
  while (nc.step()) {
    console.log(JSON.stringify(nc.getAsObject()));
    count++;
  }
  console.log('Count: ' + count);
  nc.free();
})();
