'use strict';
// One-shot repair: reassign category_id for the 5 products whose category was
// wiped by the prior Edit-modal bug. Source of truth: assets/product-catalog.json.
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const REASSIGN = {
  '3M Electrical Tape': 'Electrical',
  'ABC Tile Adhesive Original': 'Cement & Aggregates',
  'Alpha Zinc G.I. Corr. 24x10': 'G.I. & Steel',
  'Alpha Zinc G.I. Corr. 24x12': 'G.I. & Steel',
  'Alpha Zinc G.I. Plain #24 4x8': 'G.I. & Steel',
};

(async () => {
  const SQL = await initSqlJs();
  const dataDir = path.resolve(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'yankent.sqlite');
  const bakPath = path.join(dataDir, 'backups', `yankent.pre-category-repair.${Date.now()}.sqlite`);

  if (!fs.existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(1); }

  // Back up first (copy bytes — sql.js has no incremental write).
  fs.mkdirSync(path.dirname(bakPath), { recursive: true });
  fs.copyFileSync(dbPath, bakPath);
  console.log('Backup written:', bakPath);

  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  // Build name -> category_id map for the categories we need.
  const catStmt = db.prepare('SELECT id, name FROM categories');
  const catByName = {};
  while (catStmt.step()) { const r = catStmt.getAsObject(); catByName[r.name] = r.id; }
  catStmt.free();

  let updated = 0;
  const upd = db.prepare('UPDATE products SET category_id=? WHERE id=? AND active=1');

  for (const [name, catName] of Object.entries(REASSIGN)) {
    const catId = catByName[catName];
    if (catId == null) { console.warn(`Category "${catName}" not found in DB — skipping "${name}"`); continue; }

    const sel = db.prepare('SELECT id, category_id FROM products WHERE name=? AND active=1');
    sel.bind([name]);
    let touched = 0;
    while (sel.step()) {
      const row = sel.getAsObject();
      if (row.category_id === catId) { continue; } // already correct
      upd.run([catId, row.id]);
      console.log(`  id=${row.id} "${name}" category_id ${row.category_id} -> ${catId} (${catName})`);
      touched++;
    }
    sel.free();
    if (touched) updated += touched;
  }
  upd.free();

  if (updated === 0) {
    console.log('Nothing to update — all 5 products already have the correct category.');
    fs.unlinkSync(bakPath);
    console.log('Removed empty backup.');
    return;
  }

  // Persist the modified DB back to disk.
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log(`\nDone. ${updated} product(s) reassigned. DB saved.`);

  // Verify
  const stillNull = db.exec('SELECT COUNT(*) AS c FROM products WHERE active=1 AND category_id IS NULL')[0].values[0][0];
  console.log(`Active products with NULL category remaining: ${stillNull}`);
})();
