'use strict';

const { randomUUID } = require('crypto');
const { computeTotals, round2 } = require('../lib/money');
const { buildReceipt } = require('../lib/receipt');
const { buildAnalytics } = require('../lib/telegram');

function placeholders(n) { return Array(n).fill('?').join(','); }

function nonNegativeNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label}`);
  return n;
}

function clampLimit(value, fallback, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

// Payment methods the UI offers (see pos.js pay-grid). Validating here so a
// malformed payload can't bypass the cash-sufficiency check (only 'cash'
// triggers it) or the account-credit check (only 'account' triggers it) by
// passing an unknown string.
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'ewallet', 'account']);

function register(ipcMain, ctx) {
  const { db, guard } = ctx;
  // Cashier refunds require a short-lived, one-use approval created only
  // after an active administrator password is verified in the main process.
  const refundApprovals = new Map();
  const refundApprovalTtlMs = 2 * 60 * 1000;

  // ---- Create a sale (PENDING — stock not yet deducted) -----------------
  // The sale is recorded with status='pending'.  Stock is NOT deducted,
  // no stock movements are written, and contractor credit is NOT increased
  // until the cashier clicks PRINT on the receipt modal (pos:sales:commit).
  // If the receipt modal is closed without printing, the pending sale is
  // voided (pos:sales:void) and removed entirely.
  guard(ipcMain, 'pos:sales:create', { auth: true }, ({ session }, payload) => {
    const p = payload || {};
    const items = p.items || [];
    if (!items.length) throw new Error('Cart is empty');

    // Validate the payment method up front — the cash/account branches
    // below key off this value, so an unknown string would silently skip
    // both the cash-sufficiency check and the contractor-credit check.
    const paymentMethod = String(p.paymentMethod || '').toLowerCase();
    if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
      throw new Error('Invalid payment method: ' + (p.paymentMethod || '(empty)'));
    }

    const vatRate = nonNegativeNumber(ctx.getSetting(db, 'vat_rate') || 12, 'VAT rate');
    if (vatRate > 100) throw new Error('Invalid VAT rate');

    // Resolve every sellable field from the database. Renderer values are
    // display-only: trusting its price/factor/service flag would allow stale
    // UI state (or a malformed payload) to undercharge or bypass stock.
    const productStmt = db.prepare(
      'SELECT id, sku, name, base_unit, is_service FROM products WHERE id=? AND active=1'
    );
    const unitStmt = db.prepare(
      'SELECT unit, factor, price FROM product_units WHERE product_id=? AND unit=?'
    );
    const lineItems = items.map((i) => {
      const qty = Number(i.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid item quantity');
      const productId = Number(i.productId);
      if (!Number.isInteger(productId) || productId <= 0) throw new Error('Invalid product');
      const product = productStmt.get(productId);
      if (!product) throw new Error('Product not found or inactive');
      const requestedUnit = String(i.unit || product.base_unit || '').trim();
      const sellUnit = unitStmt.get(productId, requestedUnit);
      if (!sellUnit) throw new Error(`Invalid unit for ${product.name}: ${requestedUnit || '(empty)'}`);
      const unitPrice = nonNegativeNumber(sellUnit.price, 'unit price');
      const factor = Number(sellUnit.factor);
      if (!Number.isFinite(factor) || factor <= 0) throw new Error(`Invalid stock factor for ${product.name}`);
      const isService = !!product.is_service;
      return {
        productId,
        sku: product.sku, name: product.name, unit: sellUnit.unit,
        qty, unitPrice, factor,
        amount: round2(qty * unitPrice),
        lineType: isService ? 'service' : 'product',
        stockConsumed: round2(qty * factor),
        isService,
      };
    });

    const discount = nonNegativeNumber(p.discount ?? 0, 'discount');
    const deliveryFee = nonNegativeNumber(p.deliveryFee ?? 0, 'delivery fee');

    const totals = computeTotals(lineItems, {
      vatRate,
      discount,
      deliveryFee,
    });

    const tendered = paymentMethod === 'cash'
      ? nonNegativeNumber(p.amountTendered ?? 0, 'cash received')
      : 0;
    if (paymentMethod === 'cash' && tendered < totals.total - 1e-9) {
      throw new Error('Insufficient cash received');
    }
    const change = paymentMethod === 'cash' ? round2(tendered - totals.total) : 0;

    // Customer / on-account credit
    let customer = null;
    if (p.customerId) customer = db.prepare('SELECT * FROM customers WHERE id=?').get(p.customerId);
    const customerName = customer ? customer.name : (p.customerName || 'Walk-in Customer');
    if (paymentMethod === 'account') {
      if (!customer || customer.type !== 'contractor') throw new Error('On-account requires a contractor customer');
      if (customer.credit_used + totals.total > customer.credit_limit + 1e-9) throw new Error('Exceeds credit limit');
    }

    // Stock validation (check sufficient stock up front so the cashier
    // knows immediately if there isn't enough — the actual deduction
    // happens at commit time and is re-validated then).
    for (const i of lineItems) {
      if (i.isService) continue;
      const prod = db.prepare('SELECT stock, is_service FROM products WHERE id=?').get(i.productId);
      if (!prod) throw new Error('Product not found: ' + i.sku);
      if (!prod.is_service && prod.stock < i.stockConsumed - 1e-9) {
        throw new Error(`Insufficient stock for ${i.name} (have ${prod.stock} base units)`);
      }
    }

    const result = db.transaction(() => {
      // Insert the sale row first to get an atomic autoincrement id, then
      // derive the human-readable txn_id from it.  This eliminates the race
      // condition where two concurrent sales could compute the same
      // MAX(seq)+1 and collide on the UNIQUE(txn_id) constraint.
      const now = new Date();
      const datetime = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');

      const cols = ['txn_id','seq','datetime','cashier_id','cashier_name','customer_id','customer_name',
        'project','po_number','subtotal','vat','discount','delivery_fee','total','payment_method',
        'amount_tendered','change','reference','status'];
      const args = ['PENDING', 0, datetime, session.id, session.full_name, p.customerId || null, customerName,
        p.project || null, p.poNumber || null, totals.subtotal, totals.vat, discount,
        deliveryFee, totals.total, paymentMethod, tendered, change, p.reference || null,
        'pending'];
      const info = db.prepare(`INSERT INTO sales (${cols.join(',')}) VALUES (${placeholders(cols.length)})`).run(...args);
      const saleId = info.lastInsertRowid;
      const seq = saleId;
      const txnId = 'YK-' + String(seq).padStart(6, '0');
      db.prepare('UPDATE sales SET txn_id=?, seq=? WHERE id=?').run(txnId, seq, saleId);

      // Record sale items only — NO stock decrement, NO movements, NO
      // credit update until the sale is committed (PRINT clicked).
      const itemCols = ['sale_id','product_id','sku','name','unit','qty','unit_price','amount','line_type','stock_consumed'];
      const insItem = db.prepare(`INSERT INTO sale_items (${itemCols.join(',')}) VALUES (${placeholders(itemCols.length)})`);
      for (const i of lineItems) {
        insItem.run(saleId, i.productId, i.sku, i.name, i.unit, i.qty, i.unitPrice, i.amount, i.lineType, i.stockConsumed);
      }
      return { saleId, txnId };
    })();

    const receipt = buildReceipt(db, result.saleId);
    return { ...result, receipt };
  });

  // ---- Commit a pending sale (PRINT clicked → deduct stock) -------------
  // Deducts stock, writes stock movements, updates contractor credit, and
  // marks the sale status='completed'.  Throws if the sale is not pending.
  guard(ipcMain, 'pos:sales:commit', { auth: true }, ({ session }, txnId) => {
    const sale = db.prepare('SELECT * FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) throw new Error('Sale not found: ' + txnId);
    if (sale.status !== 'pending') throw new Error('Sale is not pending (already ' + sale.status + ')');
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.id);

    // Re-validate stock at commit time — another sale may have been
    // committed between create and commit, reducing available stock.
    for (const it of items) {
      if (it.line_type === 'service' || !it.product_id) continue;
      const prod = db.prepare('SELECT stock, is_service FROM products WHERE id=?').get(it.product_id);
      if (!prod) throw new Error('Product not found: ' + it.sku);
      if (!prod.is_service && prod.stock < it.stock_consumed - 1e-9) {
        throw new Error(`Insufficient stock for ${it.name} (have ${prod.stock} base units)`);
      }
    }

    db.transaction(() => {
      // Credit may have changed after this pending sale was created. Check it
      // again at commit time before stock or balances are mutated.
      if (sale.payment_method === 'account') {
        const customer = db.prepare('SELECT type, credit_limit, credit_used FROM customers WHERE id=?').get(sale.customer_id);
        if (!customer || customer.type !== 'contractor') throw new Error('On-account customer is no longer available');
        if (customer.credit_used + sale.total > customer.credit_limit + 1e-9) throw new Error('Exceeds credit limit');
      }
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
      const movStmt = db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)');
      for (const it of items) {
        if (it.line_type === 'service' || !it.product_id) continue;
        decStock.run(it.stock_consumed, it.product_id);
        movStmt.run(it.product_id, 'sale', -it.stock_consumed, 'Sale ' + txnId, session.id);
      }
      if (sale.payment_method === 'account' && sale.customer_id) {
        db.prepare('UPDATE customers SET credit_used = credit_used + ? WHERE id=?').run(sale.total, sale.customer_id);
      }
      db.prepare("UPDATE sales SET status='completed' WHERE id=?").run(sale.id);
    })();

    return { ok: true, txnId, status: 'completed' };
  });

  // ---- Void a pending sale (closed without printing → delete) -----------
  // Deletes the pending sale and its items.  No stock was deducted at
  // create time, so nothing needs to be restocked.  Completed sales cannot
  // be voided (use the refund flow instead).
  guard(ipcMain, 'pos:sales:void', { auth: true }, (_c, txnId) => {
    const sale = db.prepare('SELECT id FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) throw new Error('Sale not found: ' + txnId);
    const cur = db.prepare('SELECT status FROM sales WHERE id=?').get(sale.id);
    if (cur.status !== 'pending') throw new Error('Cannot void a ' + cur.status + ' sale (use refund instead)');
    db.transaction(() => {
      db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(sale.id);
      db.prepare('DELETE FROM sales WHERE id=?').run(sale.id);
    })();
    return { ok: true, txnId };
  });

  // ---- List / get / recent ----------------------------------------------
  // Pending sales (not yet printed) are excluded from the list — they only
  // exist while the receipt modal is open and are voided if not printed.
  guard(ipcMain, 'pos:sales:list', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT id, txn_id, datetime, cashier_name, customer_name, total, payment_method, status FROM sales WHERE status='completed'`;
    const params = [];
    if (f.from) { sql += ` AND datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    if (f.cashierId) { sql += ` AND cashier_id=?`; params.push(f.cashierId); }
    sql += ` ORDER BY datetime DESC LIMIT ?`;
    params.push(clampLimit(f.limit, 200, 1000));
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:sales:recent', { auth: true }, (_c, limit = 10) =>
    db.prepare("SELECT id, txn_id, datetime, cashier_name, total, payment_method FROM sales WHERE status='completed' ORDER BY datetime DESC LIMIT ?").all(clampLimit(limit, 10, 100))
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

  // ---- Refunds -----------------------------------------------------------
  // Find a sale by txn ID (for the refund lookup screen)
  guard(ipcMain, 'pos:refunds:lookup', { auth: true }, (_c, txnId) => {
    const sale = db.prepare('SELECT * FROM sales WHERE txn_id=? AND status=?').get(txnId, 'completed');
    if (!sale) return null;
    sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.id);
    return sale;
  });

  // Verify admin PIN (for refund approval)
  guard(ipcMain, 'pos:refunds:verifyAdmin', { auth: true }, async ({ session }, pin, txnId) => {
    const { verifyPassword } = require('../lib/auth');
    const requestedTxnId = String(txnId || '').trim();
    if (!requestedTxnId) throw new Error('Transaction ID is required for refund approval');
    const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
    for (const a of admin) {
      if (verifyPassword(pin, a.password_hash)) {
        const approvalToken = randomUUID();
        const expiresAt = Date.now() + refundApprovalTtlMs;
        refundApprovals.set(approvalToken, {
          adminId: a.id,
          adminName: a.full_name,
          requestedBy: session.id,
          txnId: requestedTxnId,
          expiresAt,
        });
        return { ok: true, admin: { id: a.id, name: a.full_name }, approvalToken, expiresAt };
      }
    }
    return { ok: false };
  });

  // Process a refund: restock items, mark sale as refunded, log refund, print receipt
  guard(ipcMain, 'pos:refunds:process', { auth: true }, (_c, payload = {}) => {
    const { session } = _c;
    const txnId = String(payload.txnId || '').trim();
    const reason = String(payload.reason || '').trim();
    if (reason.length < 3) throw new Error('A refund reason is required');
    const sale = db.prepare('SELECT * FROM sales WHERE txn_id=? AND status=?').get(txnId, 'completed');
    if (!sale) throw new Error('Sale not found or already refunded');
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(sale.id);

    let adminId;
    let adminName;
    if (session.role === 'admin') {
      adminId = session.id;
      adminName = session.full_name;
    } else {
      const approvalToken = String(payload.approvalToken || '');
      const approval = refundApprovals.get(approvalToken);
      if (!approval || approval.requestedBy !== session.id || approval.txnId !== txnId || approval.expiresAt < Date.now()) {
        if (approval && approval.expiresAt < Date.now()) refundApprovals.delete(approvalToken);
        throw new Error('Administrator approval is required for refunds');
      }
      // Consume before mutating data so the same approval cannot authorize a
      // second refund through a replayed renderer request.
      refundApprovals.delete(approvalToken);
      adminId = approval.adminId;
      adminName = approval.adminName;
    }

    const result = db.transaction(() => {
      // Mark original sale as refunded
      db.prepare("UPDATE sales SET status='refunded', note=? WHERE id=?").run('Refunded: ' + (reason || ''), sale.id);

      // Restock items (non-service only)
      const restockStmt = db.prepare('UPDATE products SET stock = stock + ? WHERE id=?');
      const movStmt = db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)');
      for (const it of items) {
        if (it.line_type === 'product' && it.product_id && it.stock_consumed > 0) {
          restockStmt.run(it.stock_consumed, it.product_id);
          movStmt.run(it.product_id, 'refund', it.stock_consumed, 'Refund ' + txnId, _c.session?.id || null);
        }
      }

      // If on-account, reduce credit_used — but only if the customer still
      // exists.  (Edge case: customer deleted between sale and refund.  The
      // UPDATE matches no row and silently no-ops; log it so it isn't a
      // silent data inconsistency.)
      if (sale.payment_method === 'account' && sale.customer_id) {
        const info = db.prepare('UPDATE customers SET credit_used = MAX(0, credit_used - ?) WHERE id=?').run(sale.total, sale.customer_id);
        if (info.changes === 0) console.warn('[refund] customer id=' + sale.customer_id + ' not found for credit adjustment on ' + txnId);
      }

      // Create refund record — use the autoincrement id for the refund txn id.
      // Insert with a placeholder first, then update with the real id to
      // avoid the same MAX(id)+1 race condition as sales.
      const now = new Date();
      const dt = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

      const refundInfo = db.prepare(
        `INSERT INTO refunds(original_txn_id, original_sale_id, refund_txn_id, datetime, cashier_id, cashier_name, admin_id, admin_name, customer_name, total, reason, items_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        txnId, sale.id, 'PENDING', dt,
        _c.session?.id || null, _c.session?.full_name || '',
        adminId, adminName,
        sale.customer_name, sale.total, reason || '',
        JSON.stringify(items)
      );
      const refundId = refundInfo.lastInsertRowid;
      const refundTxnId = 'RF-' + String(refundId).padStart(6, '0');
      db.prepare('UPDATE refunds SET refund_txn_id=? WHERE id=?').run(refundTxnId, refundId);

      return { refundTxnId, total: sale.total, approvedBy: adminName, approvedById: adminId };
    })();

    return result;
  });

  // List refunds (for reports)
  guard(ipcMain, 'pos:refunds:list', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT r.*, s.payment_method FROM refunds r JOIN sales s ON r.original_sale_id = s.id WHERE 1=1`;
    const params = [];
    if (f.from) { sql += ` AND r.datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND r.datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    sql += ` ORDER BY r.datetime DESC LIMIT ?`;
    // Cap the limit so a malformed/careless caller can't request millions
    // of rows and freeze the UI — matches the sales:list cap above.
    params.push(clampLimit(f.limit, 100, 1000));
    return db.prepare(sql).all(...params);
  });

  guard(ipcMain, 'pos:refunds:summary', { auth: true }, () => {
    const today = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM refunds WHERE date(datetime)=date('now','localtime')`
    ).get();
    const month = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM refunds WHERE strftime('%Y-%m',datetime)=strftime('%Y-%m','now','localtime')`
    ).get();
    return { today, month };
  });

  // ---- Reports -----------------------------------------------------------
  guard(ipcMain, 'pos:reports:summary', { auth: true }, () => {
    const today = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' AND date(datetime)=date('now','localtime')`).get();
    const yesterday = db.prepare(
      `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
       WHERE status='completed' AND date(datetime)=date('now','localtime','-1 day')`).get();
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
    return { today, yesterday, month, year, bestDay };
  });

  guard(ipcMain, 'pos:reports:bestSelling', { auth: true }, (_c, f = {}) => {
    let sql = `SELECT si.sku, si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total, COUNT(*) AS lines
      FROM sale_items si JOIN sales s ON si.sale_id=s.id
      WHERE s.status='completed'`;
    const params = [];
    if (f.from) { sql += ` AND s.datetime >= ?`; params.push(f.from + ' 00:00:00'); }
    if (f.to) { sql += ` AND s.datetime <= ?`; params.push(f.to + ' 23:59:59'); }
    sql += ` GROUP BY si.product_id ORDER BY total DESC LIMIT ?`;
    params.push(clampLimit(f.limit, 10, 1000));
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

  guard(ipcMain, 'pos:reports:analytics', { auth: true }, () => buildAnalytics(db));

  guard(ipcMain, 'pos:reports:exportCSV', { auth: true }, async (_c, type, f = {}) => {
    const fs = require('fs');
    let rows, header;
    if (type === 'bestSelling') {
      rows = db.prepare(`SELECT si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total
        FROM sale_items si JOIN sales s ON si.sale_id=s.id WHERE s.status='completed'
        GROUP BY si.product_id ORDER BY total DESC`).all();
      header = ['Name','Qty','Total'];
    } else if (type === 'byCashier') {
      rows = db.prepare(`SELECT cashier_name, COUNT(*) AS tx, SUM(total) AS total FROM sales WHERE status='completed' GROUP BY cashier_id ORDER BY total DESC`).all();
      header = ['Cashier','Transactions','Total'];
    } else if (type === 'salesByDay') {
      rows = db.prepare(`SELECT date(datetime) AS date, COUNT(*) AS tx, SUM(total) AS total FROM sales WHERE status='completed' GROUP BY date(datetime) ORDER BY date DESC`).all();
      header = ['Date','Transactions','Total'];
    } else if (type === 'deliveries') {
      rows = db.prepare(`SELECT sm.datetime, p.sku, p.name, sm.qty_change, p.base_unit, sm.movement, sm.reason, sm.source_location, u.full_name AS user_name
        FROM stock_movements sm LEFT JOIN products p ON sm.product_id=p.id LEFT JOIN users u ON sm.user_id=u.id
        WHERE sm.qty_change > 0 ORDER BY sm.datetime DESC`).all();
      header = ['Date','SKU','Product','Qty Added','Unit','Type','Reason','Location','Restocked By'];
      const dm = { Date:'datetime', SKU:'sku', Product:'name', 'Qty Added':'qty_change', Unit:'base_unit', Type:'movement', Reason:'reason', Location:'source_location', 'Restocked By':'user_name' };
      const csv = [header.join(',')].concat(rows.map((r) => header.map((h) => csvCell(r[dm[h] || lowerFirst(h)])).join(','))).join('\n');
      const res = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
        title: 'Export restock history', defaultPath: `yankent-restocks-${Date.now()}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, '\uFEFF' + csv, 'utf8');
      return res.filePath;
    } else {
      // Only completed sales — exclude pending (never printed) and refunded
      // so the exported CSV matches the on-screen "Recent Sales" table.
      rows = db.prepare(`SELECT txn_id, datetime, cashier_name, customer_name, total, payment_method FROM sales WHERE status='completed' ORDER BY datetime DESC`).all();
      header = ['Txn','Date','Cashier','Customer','Total','Payment'];
    }
    const csv = [header.join(',')].concat(rows.map((r) => header.map((h) => csvCell(r[lowerFirst(h)])).join(','))).join('\n');
    const res = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
      title: 'Export ' + type, defaultPath: `yankent-${type}-${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, '\uFEFF' + csv, 'utf8');
    return res.filePath;
  });

  // ---- Reset all sales (admin) -----------------------------------------
  // Wipes sales, sale_items, refunds, and stock_movements while preserving
  // users, products, customers, categories, and settings. Recomputes product
  // stock to zero for stock-bearing products.
  guard(ipcMain, 'pos:sales:reset', { admin: true }, () => {
    const tx = db.transaction(() => {
      // Delete in FK-safe order (children first).
      db.exec('DELETE FROM sale_items;');
      db.exec('DELETE FROM refunds;');
      db.exec('DELETE FROM stock_movements;');
      db.exec('DELETE FROM sales;');
      // Reset autoincrement counters for the wiped tables.
      db.prepare('DELETE FROM sqlite_sequence WHERE name IN (?,?,?,?)')
        .run('sales', 'sale_items', 'refunds', 'stock_movements');
      // Recompute product stock: no movements means zero consumed, but stock
      // is the source-of-truth column on products. Reset stock-bearing products
      // to 0 since all movements (the audit trail) were wiped.
      db.prepare("UPDATE products SET stock = 0 WHERE is_service = 0 OR is_service IS NULL").run();
      // Reset contractor credit accounts — all sales that generated
      // credit_used were deleted, so the balances are now meaningless.
      // Without this, contractor "credit used" stays inflated after a wipe
      // and the available credit is permanently understated.
      db.prepare("UPDATE customers SET credit_used = 0").run();
    });
    tx();
    return { ok: true };
  });
}

function lowerFirst(s) {
  // map header label to row key: 'SKU'->'sku', 'Total'->'total', 'Transactions'->'tx'
  const m = { SKU:'sku', Name:'name', Qty:'qty', Total:'total', Cashier:'cashier_name', Transactions:'tx', Date:'date', Txn:'txn_id', Customer:'customer_name', Payment:'payment_method' };
  return m[s] || s;
}function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { register };
