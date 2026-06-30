'use strict';

const { computeTotals, round2 } = require('../lib/money');
const { buildReceipt } = require('../lib/receipt');

function placeholders(n) { return Array(n).fill('?').join(','); }

function register(ipcMain, ctx) {
  const { db, guard } = ctx;

  // ---- Create a sale -----------------------------------------------------
  guard(ipcMain, 'pos:sales:create', { auth: true }, ({ session }, payload) => {
    const p = payload || {};
    const items = p.items || [];
    if (!items.length) throw new Error('Cart is empty');

    const vatRate = Number(ctx.getSetting(db, 'vat_rate') || 12);

    // Authoritatively recompute line amounts + totals (renderer values are
    // display-only; the DB is the source of truth).
    const lineItems = items.map((i) => {
      const qty = Number(i.qty);
      const unitPrice = Number(i.unitPrice);
      if (!(qty > 0) || unitPrice < 0) throw new Error('Invalid item: ' + (i.name || ''));
      const factor = Number(i.factor || 1);
      return {
        productId: i.productId || null,
        sku: i.sku, name: i.name, unit: i.unit || 'pc',
        qty, unitPrice, factor,
        amount: round2(qty * unitPrice),
        lineType: i.lineType || (i.isService ? 'service' : 'product'),
        stockConsumed: round2(qty * factor),
        isService: !!i.isService || i.lineType === 'service',
      };
    });

    const totals = computeTotals(lineItems, {
      vatRate,
      discount: Number(p.discount || 0),
      deliveryFee: Number(p.deliveryFee || 0),
    });

    const tendered = Number(p.amountTendered || 0);
    if (p.paymentMethod === 'cash' && tendered < totals.total - 1e-9) {
      throw new Error('Insufficient cash received');
    }
    const change = p.paymentMethod === 'cash' ? round2(tendered - totals.total) : 0;

    // Customer / on-account credit
    let customer = null;
    if (p.customerId) customer = db.prepare('SELECT * FROM customers WHERE id=?').get(p.customerId);
    const customerName = customer ? customer.name : (p.customerName || 'Walk-in Customer');
    if (p.paymentMethod === 'account') {
      if (!customer || customer.type !== 'contractor') throw new Error('On-account requires a contractor customer');
      if (customer.credit_used + totals.total > customer.credit_limit + 1e-9) throw new Error('Exceeds credit limit');
    }

    // Stock validation
    for (const i of lineItems) {
      if (i.isService) continue;
      const prod = db.prepare('SELECT stock, is_service FROM products WHERE id=?').get(i.productId);
      if (!prod) throw new Error('Product not found: ' + i.sku);
      if (!prod.is_service && prod.stock < i.stockConsumed - 1e-9) {
        throw new Error(`Insufficient stock for ${i.name} (have ${prod.stock} base units)`);
      }
    }

    const result = db.transaction(() => {
      const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM sales').get().s;
      const txnId = 'YK-' + String(seq).padStart(6, '0');
      const now = new Date();
      const datetime = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');

      const cols = ['txn_id','seq','datetime','cashier_id','cashier_name','customer_id','customer_name',
        'project','po_number','subtotal','vat','discount','delivery_fee','total','payment_method',
        'amount_tendered','change','reference'];
      const args = [txnId, seq, datetime, session.id, session.full_name, p.customerId || null, customerName,
        p.project || null, p.poNumber || null, totals.subtotal, totals.vat, Number(p.discount || 0),
        Number(p.deliveryFee || 0), totals.total, p.paymentMethod, tendered, change, p.reference || null];
      const info = db.prepare(`INSERT INTO sales (${cols.join(',')}) VALUES (${placeholders(cols.length)})`).run(...args);
      const saleId = info.lastInsertRowid;

      const itemCols = ['sale_id','product_id','sku','name','unit','qty','unit_price','amount','line_type','stock_consumed'];
      const insItem = db.prepare(`INSERT INTO sale_items (${itemCols.join(',')}) VALUES (${placeholders(itemCols.length)})`);
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
      const movStmt = db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)');

      for (const i of lineItems) {
        insItem.run(saleId, i.productId, i.sku, i.name, i.unit, i.qty, i.unitPrice, i.amount, i.lineType, i.stockConsumed);
        if (!i.isService && i.productId) {
          decStock.run(i.stockConsumed, i.productId);
          movStmt.run(i.productId, 'sale', -i.stockConsumed, 'Sale ' + txnId, session.id);
        }
      }
      if (p.paymentMethod === 'account' && customer) {
        db.prepare('UPDATE customers SET credit_used = credit_used + ? WHERE id=?').run(totals.total, customer.id);
      }
      return { saleId, txnId };
    })();

    const receipt = buildReceipt(db, result.saleId);
    return { ...result, receipt };
  });

  // ---- List / get / recent ----------------------------------------------
  guard(ipcMain, 'pos:sales:list', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT id, txn_id, datetime, cashier_name, customer_name, total, payment_method, status FROM sales WHERE 1=1`;
    const params = [];
    if (f.from) { sql += ` AND datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    if (f.cashierId) { sql += ` AND cashier_id=?`; params.push(f.cashierId); }
    sql += ` ORDER BY datetime DESC LIMIT ?`;
    params.push(Math.min(f.limit || 200, 1000));
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:sales:recent', { auth: true }, (_c, limit = 10) =>
    db.prepare('SELECT id, txn_id, datetime, cashier_name, total, payment_method FROM sales ORDER BY datetime DESC LIMIT ?').all(limit)
  );

  guard(ipcMain, 'pos:sales:get', { auth: true }, (_c, txnId) => {
    const sale = db.prepare('SELECT * FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) return null;
    sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.id);
    return sale;
  });

  guard(ipcMain, 'pos:sales:receipt', { auth: true }, (_c, txnId) => {
    const sale = db.prepare('SELECT id FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) return null;
    return buildReceipt(db, sale.id);
  });

  // ---- Reports -----------------------------------------------------------
  guard(ipcMain, 'pos:reports:summary', { auth: true }, () => {
    const today = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' AND date(datetime)=date('now','localtime')`).get();
    const month = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' AND strftime('%Y-%m',datetime)=strftime('%Y-%m','now','localtime')`).get();
    const year = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' AND strftime('%Y',datetime)=strftime('%Y','now','localtime')`).get();
    const best = db.prepare(
      `SELECT date(datetime) AS d, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' GROUP BY date(datetime) ORDER BY total DESC LIMIT 1`).get();
    let bestDay = null;
    if (best && best.d) {
      const dt = new Date(best.d + 'T00:00:00');
      bestDay = { date: best.d, label: dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), total: best.total };
    }
    return { today, month, year, bestDay };
  });

  guard(ipcMain, 'pos:reports:bestSelling', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT si.sku, si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total, COUNT(*) AS lines
      FROM sale_items si JOIN sales s ON si.sale_id=s.id
      WHERE s.status='completed'`;
    const params = [];
    if (f.from) { sql += ` AND s.datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND s.datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    sql += ` GROUP BY si.product_id ORDER BY total DESC LIMIT ?`;
    params.push(f.limit || 10);
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:reports:byCashier', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT s.cashier_name, COUNT(*) AS tx, COALESCE(SUM(s.total),0) AS total
      FROM sales s WHERE s.status='completed'`;
    const params = [];
    if (f.from) { sql += ` AND s.datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND s.datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    sql += ` GROUP BY s.cashier_id ORDER BY total DESC`;
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:reports:salesByDay', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT date(datetime) AS date, COUNT(*) AS tx, COALESCE(SUM(total),0) AS total
      FROM sales WHERE status='completed'`;
    const params = [];
    if (f.from) { sql += ` AND datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    sql += ` GROUP BY date(datetime) ORDER BY date DESC`;
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:reports:exportCSV', { auth: true }, async (_c, type, f = {}) => {
    let rows, header;
    if (type === 'bestSelling') {
      rows = db.prepare(`SELECT si.sku, si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total
        FROM sale_items si JOIN sales s ON si.sale_id=s.id WHERE s.status='completed'
        GROUP BY si.product_id ORDER BY total DESC`).all();
      header = ['SKU','Name','Qty','Total'];
    } else if (type === 'byCashier') {
      rows = db.prepare(`SELECT cashier_name, COUNT(*) AS tx, SUM(total) AS total FROM sales WHERE status='completed' GROUP BY cashier_id ORDER BY total DESC`).all();
      header = ['Cashier','Transactions','Total'];
    } else if (type === 'salesByDay') {
      rows = db.prepare(`SELECT date(datetime) AS date, COUNT(*) AS tx, SUM(total) AS total FROM sales WHERE status='completed' GROUP BY date(datetime) ORDER BY date DESC`).all();
      header = ['Date','Transactions','Total'];
    } else {
      rows = db.prepare(`SELECT txn_id, datetime, cashier_name, customer_name, total, payment_method FROM sales ORDER BY datetime DESC`).all();
      header = ['Txn','Date','Cashier','Customer','Total','Payment'];
    }
    const csv = [header.join(',')].concat(rows.map((r) => header.map((h) => csvCell(r[lowerFirst(h)])).join(','))).join('\n');
    const res = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
      title: 'Export ' + type, defaultPath: `yankent-${type}-${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const fs = require('fs');
    fs.writeFileSync(res.filePath, '\uFEFF' + csv, 'utf8');
    return res.filePath;
  });
}

function lowerFirst(s) {
  // map header label to row key: 'SKU'->'sku', 'Total'->'total', 'Transactions'->'tx'
  const m = { SKU:'sku', Name:'name', Qty:'qty', Total:'total', Cashier:'cashier_name', Transactions:'tx', Date:'date', Txn:'txn_id', Customer:'customer_name', Payment:'payment_method' };
  return m[s] || s;
}
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { register };
