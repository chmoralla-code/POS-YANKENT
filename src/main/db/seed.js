'use strict';

/**
 * Seed demo data (from the construction-supply POS prototypes).
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

    // ---- Categories ------------------------------------------------------
    const insCat = db.prepare('INSERT INTO categories(name, sort) VALUES(?, ?)');
    const catNames = [
      'Cement', 'Masonry', 'Lumber', 'Steel', 'Plumbing',
      'Electrical', 'Paint', 'Tools', 'Fasteners', 'Services',
    ];
    const catId = {};
    catNames.forEach((name, i) => { catId[name] = insCat.run(name, i).lastInsertRowid; });

    // ---- Customers / contractor accounts --------------------------------
    const insCust = db.prepare(
      'INSERT INTO customers(name, type, phone, credit_limit, credit_used) VALUES(?,?,?,?,?)'
    );
    insCust.run('Walk-in Customer', 'walkin', '', 0, 0);
    insCust.run('ABC Construction', 'contractor', '0917 111 2222', 50000, 12000);
    insCust.run('Mendoza Builders', 'contractor', '0918 333 4444', 80000, 35000);
    insCust.run('Rivera Contractors', 'contractor', '0919 555 6666', 30000, 8000);
    insCust.run('Rivera Residence', 'walkin', '0920 777 8888', 0, 0);

    // ---- Products + sellable units --------------------------------------
    // Each product: [sku, name, category, base_unit, stock, price, cost, is_service, [[unit, factor, price], ...]]
    const P = [
      ['CMT-001', 'Portland Cement 40kg', 'Cement', 'bag', 120, 280, 235, 0,
        [['bag', 1, 280], ['sack(50kg)', 1.25, 350]]],
      ['CMT-002', 'Holcim Cement 40kg', 'Cement', 'bag', 85, 295, 250, 0,
        [['bag', 1, 295]]],
      ['HBL-040', 'Hollow Blocks 4"', 'Masonry', 'pc', 2000, 18, 14, 0,
        [['pc', 1, 18]]],
      ['HBL-060', 'Hollow Blocks 6"', 'Masonry', 'pc', 1500, 22, 17, 0,
        [['pc', 1, 22]]],
      ['SAN-001', 'Washed Sand', 'Masonry', 'cu.m', 50, 1200, 900, 0,
        [['cu.m', 1, 1200], ['sack', 0.04, 60], ['triport', 0.5, 650]]],
      ['GRA-001', 'Gravel 3/4"', 'Masonry', 'cu.m', 35, 1400, 1050, 0,
        [['cu.m', 1, 1400], ['sack', 0.04, 70]]],
      ['LBR-2x4', 'Lumber 2x4x8ft (Kiln Dry)', 'Lumber', 'pc', 240, 185, 150, 0,
        [['pc', 1, 185]]],
      ['LBR-2x6', 'Lumber 2x6x8ft', 'Lumber', 'pc', 160, 245, 200, 0,
        [['pc', 1, 245]]],
      ['PLY-34', 'Plywood 3/4" 4x8', 'Lumber', 'pc', 48, 780, 640, 0,
        [['pc', 1, 780], ['sq.m', 0.5, 390]]],
      ['LBR-BF', 'Tanguile Lumber (per board foot)', 'Lumber', 'BF', 8000, 32, 26, 0,
        [['BF', 1, 32], ['pc 2x4x8', 5.33, 170], ['pc 2x4x12', 8, 256]]],
      ['RBR-10', 'Rebar #3 (10mm) 6m', 'Steel', 'pc', 300, 165, 138, 0,
        [['pc', 1, 165]]],
      ['RBR-12', 'Rebar #4 (12mm) 6m', 'Steel', 'pc', 220, 215, 180, 0,
        [['pc(6m)', 1, 215], ['meter', 0.1667, 36], ['kg', 0.53, 114]]],
      ['RBR-16', 'Rebar #5 (16mm) 6m', 'Steel', 'pc', 140, 310, 260, 0,
        [['pc', 1, 310]]],
      ['ANG-1x1', 'Angle Bar 1x1x6m', 'Steel', 'pc', 90, 420, 350, 0,
        [['pc', 1, 420]]],
      ['PVC-12', 'PVC Pipe 1/2" x 3m', 'Plumbing', 'pc', 180, 135, 110, 0,
        [['pc(3m)', 1, 135], ['meter', 0.3333, 48], ['cut', 0.33, 50]]],
      ['PVC-34', 'PVC Pipe 3/4" x 3m', 'Plumbing', 'pc', 140, 175, 145, 0,
        [['pc', 1, 175]]],
      ['ELB-12', 'PVC Elbow 1/2"', 'Plumbing', 'pc', 600, 14, 9, 0,
        [['pc', 1, 14]]],
      ['FCT-001', 'Faucet Chrome', 'Plumbing', 'pc', 35, 480, 380, 0,
        [['pc', 1, 480]]],
      ['WIR-14', 'THHN Wire #14 100m', 'Electrical', 'roll', 42, 980, 820, 0,
        [['roll(100m)', 1, 980], ['meter', 0.01, 12]]],
      ['WIR-12', 'THHN Wire #12 100m', 'Electrical', 'roll', 28, 1250, 1050, 0,
        [['roll(100m)', 1, 1250], ['meter', 0.01, 15]]],
      ['OVL-001', 'Switch Outlet Combo', 'Electrical', 'pc', 200, 95, 70, 0,
        [['pc', 1, 95]]],
      ['BRK-001', 'Circuit Breaker 30A', 'Electrical', 'pc', 60, 280, 220, 0,
        [['pc', 1, 280]]],
      ['PNT-1W', 'Boysen White 1gal', 'Paint', 'gal', 75, 685, 560, 0,
        [['gal', 1, 685], ['quart', 0.25, 195], ['liter', 0.264, 190]]],
      ['PNT-4W', 'Boysen White 4gal', 'Paint', 'gal', 22, 2450, 2050, 0,
        [['gal', 1, 2450]]],
      ['PNT-PR', 'Primer 1gal', 'Paint', 'gal', 40, 580, 470, 0,
        [['gal', 1, 580]]],
      ['TOL-HMR', 'Claw Hammer 16oz', 'Tools', 'pc', 50, 320, 250, 0,
        [['pc', 1, 320]]],
      ['TOL-SLV', 'Spirit Level 24"', 'Tools', 'pc', 32, 480, 390, 0,
        [['pc', 1, 480]]],
      ['TOL-MTR', 'Measuring Tape 5m', 'Tools', 'pc', 88, 185, 140, 0,
        [['pc', 1, 185]]],
      ['NIL-2', 'Common Nails 2" (per kg)', 'Fasteners', 'kg', 120, 95, 78, 0,
        [['kg', 1, 95], ['250g', 0.25, 28], ['box(5kg)', 5, 450]]],
      ['NIL-3', 'Common Nails 3" (per kg)', 'Fasteners', 'kg', 100, 98, 80, 0,
        [['kg', 1, 98]]],
      ['SCR-1', 'Wood Screws 1" (per box)', 'Fasteners', 'box', 200, 145, 115, 0,
        [['box', 1, 145]]],
      // ---- Services (no stock consumption) -------------------------------
      ['SVC-CUT', 'Wood Cutting Service', 'Services', 'per cut', 0, 25, 0, 1,
        [['per cut', 1, 25]]],
      ['SVC-CUT2', 'Rebar Cutting/Bending', 'Services', 'per cut', 0, 35, 0, 1,
        [['per cut', 1, 35]]],
      ['SVC-DEL', 'Delivery (within 10km)', 'Services', 'per trip', 0, 250, 0, 1,
        [['per trip', 1, 250]]],
      ['SVC-DEL2', 'Delivery (10-25km)', 'Services', 'per trip', 0, 450, 0, 1,
        [['per trip', 1, 450]]],
      ['SVC-PNT', 'Paint Color Mixing', 'Services', 'per gal', 0, 80, 0, 1,
        [['per gal', 1, 80]]],
      ['SVC-INS', 'Installation Labor', 'Services', 'per hr', 0, 500, 0, 1,
        [['per hr', 1, 500]]],
    ];

    const insProd = db.prepare(
      `INSERT INTO products(sku,name,category_id,base_unit,stock,cost,price,low_stock_threshold,is_service,active)
       VALUES(?,?,?,?,?,?,?,10,?,1)`
    );
    const insUnit = db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
    );

    for (const [sku, name, cat, base, stock, price, cost, isSvc, units] of P) {
      const pid = insProd.run(sku, name, catId[cat], base, stock, cost, price, isSvc).lastInsertRowid;
      for (const [u, f, p] of units) insUnit.run(pid, u, f, p);
    }
  });

  tx();
  return true;
}

module.exports = { seedDatabase };
