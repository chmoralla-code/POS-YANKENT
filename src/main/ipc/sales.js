'use strict';

const { randomUUID } = require('crypto');
const { computeTotals, round2 } = require('../lib/money');
const { buildReceipt } = require('../lib/receipt');
const { buildAnalytics } = require('../lib/telegram');
const {
  validateNewDueDate,
  createSaleLoan,
  reconcileCustomerCredit,
  cancelSaleLoan,
} = require('../lib/loans');

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

function reportDate(value, label) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid date`);
  }
  return text;
}

function buildExpensesRoiReport(db, filters = {}) {
  const from = reportDate(filters.from, 'From date');
  const to = reportDate(filters.to, 'To date');
  if (from && to && from > to) throw new Error('From date must be earlier than or equal to To date');

  const dateClauses = [];
  const params = [];
  if (from) { dateClauses.push('s.datetime >= ?'); params.push(from + ' 00:00:00'); }
  if (to) { dateClauses.push('s.datetime <= ?'); params.push(to + ' 23:59:59'); }
  const dateWhere = dateClauses.length ? ' AND ' + dateClauses.join(' AND ') : '';

  // Aggregate sale headers in SQL so all-time reports remain small even when
  // the register has years of history. Refunded sales remain in gross sales,
  // but are excluded from the product revenue and COGS used for ROI.
  const salesSummary = db.prepare(`SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(s.total),0) AS gross_sales,
      COALESCE(SUM(CASE WHEN s.status='refunded' THEN s.total ELSE 0 END),0) AS refunded_sales_total,
      COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total ELSE 0 END),0) AS net_sales,
      COALESCE(SUM(CASE WHEN s.status='completed' THEN s.subtotal ELSE 0 END),0) AS net_sales_ex_vat,
      COALESCE(SUM(CASE WHEN s.status='completed' THEN s.vat ELSE 0 END),0) AS vat,
      COALESCE(SUM(CASE WHEN s.status='completed' THEN s.discount ELSE 0 END),0) AS discounts,
      COALESCE(SUM(CASE WHEN s.status='completed' THEN s.delivery_fee ELSE 0 END),0) AS delivery_fees,
      SUM(CASE WHEN s.status='completed' THEN 1 ELSE 0 END) AS completed_transactions,
      SUM(CASE WHEN s.status='refunded' THEN 1 ELSE 0 END) AS refunded_transactions
    FROM sales s WHERE s.status IN ('completed','refunded')${dateWhere}`).get(...params) || {};

  // Refund activity follows the date the refund was processed. This is shown
  // separately from ROI, which restates the original sale period by excluding
  // every fully refunded sale from product return and cost.
  let refundSql = `SELECT COUNT(*) AS tx,COALESCE(SUM(r.total),0) AS total FROM refunds r WHERE 1=1`;
  const refundParams = [];
  if (from) { refundSql += ' AND r.datetime >= ?'; refundParams.push(from + ' 00:00:00'); }
  if (to) { refundSql += ' AND r.datetime <= ?'; refundParams.push(to + ' 23:59:59'); }
  const refundActivity = db.prepare(refundSql).get(...refundParams) || { tx: 0, total: 0 };

  // Collapse sale lines to one row per product/service. Product revenue is
  // VAT-exclusive, shares sale discounts proportionally, and excludes the
  // delivery fee. Services and delivery are reported separately and never
  // inflate physical-product ROI against product-only COGS.
  const metricRows = db.prepare(`WITH filtered_sales AS (
      SELECT s.id,s.subtotal,s.total,s.delivery_fee
      FROM sales s WHERE s.status='completed'${dateWhere}
    ), line_totals AS (
      SELECT si.sale_id,COALESCE(SUM(si.amount),0) AS line_total
      FROM sale_items si JOIN filtered_sales fs ON fs.id=si.sale_id
      GROUP BY si.sale_id
    )
    SELECT
      CASE WHEN si.product_id IS NULL
        THEN 'missing:' || COALESCE(si.sku,si.name,'unknown')
        ELSE CAST(si.product_id AS TEXT) END AS product_key,
      si.product_id,si.line_type,
      COALESCE(SUM(CASE WHEN si.line_type='product'
        THEN MAX(COALESCE(si.stock_consumed,0),0) ELSE 0 END),0) AS units_sold,
      COALESCE(SUM(CASE WHEN lt.line_total>0 AND fs.total>0
        THEN MAX(fs.total-COALESCE(fs.delivery_fee,0),0)
          * (fs.subtotal/fs.total) * (COALESCE(si.amount,0)/lt.line_total)
        ELSE 0 END),0) AS net_sales,
      COALESCE(SUM(CASE WHEN si.line_type='product'
        THEN MAX(COALESCE(si.stock_consumed,0),0) * MAX(COALESCE(p.cost,0),0)
        ELSE 0 END),0) AS cogs,
      MAX(COALESCE(p.cost,0)) AS current_cost
    FROM sale_items si
    JOIN filtered_sales fs ON fs.id=si.sale_id
    JOIN line_totals lt ON lt.sale_id=si.sale_id
    LEFT JOIN products p ON p.id=si.product_id
    GROUP BY product_key,si.product_id,si.line_type`).all(...params);

  const productMetrics = new Map();
  const soldProducts = new Set();
  const soldWithoutCost = new Set();
  let estimatedCogs = 0;
  let productNetSales = 0;
  let serviceNetSales = 0;
  for (const metricRow of metricRows) {
    const key = String(metricRow.product_key);
    const unitsSold = Math.max(0, Number(metricRow.units_sold || 0));
    const netSales = Number(metricRow.net_sales || 0);
    const cogs = Math.max(0, Number(metricRow.cogs || 0));
    if (metricRow.line_type === 'service') {
      serviceNetSales += netSales;
      continue;
    }
    productMetrics.set(key, { unitsSold, netSales, cogs });
    soldProducts.add(key);
    if (unitsSold > 0 && Number(metricRow.current_cost || 0) <= 0) soldWithoutCost.add(key);
    productNetSales += netSales;
    estimatedCogs += cogs;
  }

  const inventoryDateWhere = dateWhere.replace(/s\.datetime/g, 'history_sale.datetime');
  const inventoryProducts = db.prepare(`SELECT p.id,p.sku,p.name,p.base_unit,p.stock,p.cost,p.price,p.active,
      COALESCE(c.name,'Uncategorized') AS category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE COALESCE(p.is_service,0)=0
      AND (p.active=1 OR p.stock>0 OR EXISTS (
        SELECT 1 FROM sale_items history_item
        JOIN sales history_sale ON history_sale.id=history_item.sale_id
        WHERE history_item.product_id=p.id AND history_item.line_type='product'
          AND history_sale.status='completed'${inventoryDateWhere}
      ))
    ORDER BY p.name COLLATE NOCASE,p.id`).all(...params);

  let inventoryExpense = 0;
  let inventoryRetailValue = 0;
  let productsWithStock = 0;
  let productsWithoutCost = 0;
  const products = inventoryProducts.map((product) => {
    const stock = Number(product.stock || 0);
    const valuedStock = Math.max(0, stock);
    const unitCost = Math.max(0, Number(product.cost || 0));
    const unitPrice = Math.max(0, Number(product.price || 0));
    const inventoryValue = valuedStock * unitCost;
    const retailValue = valuedStock * unitPrice;
    if (valuedStock > 0) {
      productsWithStock++;
      if (unitCost <= 0) productsWithoutCost++;
    }
    inventoryExpense += inventoryValue;
    inventoryRetailValue += retailValue;

    const metric = productMetrics.get(String(product.id)) || { unitsSold: 0, netSales: 0, cogs: 0 };
    const profit = metric.netSales - metric.cogs;
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      base_unit: product.base_unit,
      active: !!product.active,
      stock: round2(stock),
      unit_cost: round2(unitCost),
      unit_price: round2(unitPrice),
      inventory_expense: round2(inventoryValue),
      inventory_retail_value: round2(retailValue),
      units_sold: round2(metric.unitsSold),
      net_sales: round2(metric.netSales),
      estimated_cogs: round2(metric.cogs),
      gross_profit: round2(profit),
      roi_percent: metric.cogs > 0 ? round2((profit / metric.cogs) * 100) : null,
      margin_percent: metric.netSales > 0 ? round2((profit / metric.netSales) * 100) : null,
      missing_cost: unitCost <= 0,
    };
  });

  const grossSales = Number(salesSummary.gross_sales || 0);
  const refundedTotal = Number(salesSummary.refunded_sales_total || 0);
  const netSales = Number(salesSummary.net_sales || 0);
  const netSalesExVat = Number(salesSummary.net_sales_ex_vat || 0);
  const vat = Number(salesSummary.vat || 0);
  const discounts = Number(salesSummary.discounts || 0);
  const deliveryFees = Number(salesSummary.delivery_fees || 0);
  const completedTransactions = Number(salesSummary.completed_transactions || 0);
  const refundedTransactions = Number(salesSummary.refunded_transactions || 0);
  const deliveryNetSales = netSalesExVat - productNetSales - serviceNetSales;
  const grossProfit = productNetSales - estimatedCogs;

  return {
    period: { from, to },
    generated_at: new Date().toISOString(),
    summary: {
      inventory_expense: round2(inventoryExpense),
      inventory_retail_value: round2(inventoryRetailValue),
      inventory_potential_profit: round2(inventoryRetailValue - inventoryExpense),
      gross_sales: round2(grossSales),
      refunds: round2(refundedTotal),
      refund_activity_total: round2(refundActivity.total),
      refund_activity_transactions: Number(refundActivity.tx || 0),
      net_sales: round2(netSales),
      net_sales_ex_vat: round2(netSalesExVat),
      vat: round2(vat),
      discounts: round2(discounts),
      delivery_fees: round2(deliveryFees),
      estimated_cogs: round2(estimatedCogs),
      gross_profit: round2(grossProfit),
      roi_percent: estimatedCogs > 0 ? round2((grossProfit / estimatedCogs) * 100) : null,
      margin_percent: productNetSales > 0 ? round2((grossProfit / productNetSales) * 100) : null,
      completed_transactions: completedTransactions,
      refunded_transactions: refundedTransactions,
      product_count: inventoryProducts.length,
      products_with_stock: productsWithStock,
      products_without_cost: productsWithoutCost,
      sold_product_count: soldProducts.size,
      sold_without_cost_count: soldWithoutCost.size,
      inventory_cost_coverage_percent: productsWithStock > 0
        ? round2(((productsWithStock - productsWithoutCost) / productsWithStock) * 100)
        : 100,
      product_net_sales: round2(productNetSales),
      service_net_sales: round2(serviceNetSales),
      delivery_net_sales: round2(deliveryNetSales),
    },
    products,
    methodology: {
      cost_basis: 'current_product_cost',
      revenue_basis: 'completed_physical_product_sales_excluding_vat_services_and_delivery',
      refund_basis: 'roi_restates_original_sales; refund_activity_uses_processed_date',
      cost_vat_assumption: 'cost_values_are_compared_as_entered; use_vat_exclusive_cost_when_input_vat_is_recoverable',
    },
  };
}

function register(ipcMain, ctx) {
  const { db, guard } = ctx;
  // Cashier refunds require a short-lived, one-use approval created only
  // after an active administrator password is verified in the main process.
  const refundApprovals = new Map();
  const refundApprovalTtlMs = 2 * 60 * 1000;

  // Product costs and profitability are sensitive administrator-only data.
  guard(ipcMain, 'pos:reports:expensesRoi', { admin: true }, (_context, filters = {}) =>
    buildExpensesRoiReport(db, filters || {})
  );

  // A pending sale may only be completed or voided by the exact authenticated
  // session that created it. This prevents a delayed renderer continuation
  // from a logged-out cashier being resumed under the next cashier's token.
  const pendingSaleOwners = new Map();
  const assertPendingSaleOwner = (txnId, token) => {
    const owner = pendingSaleOwners.get(txnId);
    if (!owner || owner !== token) {
      const error = new Error('This pending sale belongs to a different or expired session');
      error.code = 'PENDING_SALE_SESSION';
      throw error;
    }
  };
  const clearPendingSaleOwners = () => pendingSaleOwners.clear();
  const discardPendingSalesForToken = (token) => {
    if (!token) return 0;
    const txnIds = [...pendingSaleOwners.entries()]
      .filter(([, owner]) => owner === token)
      .map(([txnId]) => txnId);
    if (!txnIds.length) return 0;
    let removed = 0;
    db.transaction(() => {
      const getSale = db.prepare("SELECT id,status FROM sales WHERE txn_id=?");
      const deleteItems = db.prepare('DELETE FROM sale_items WHERE sale_id=?');
      const deleteSale = db.prepare('DELETE FROM sales WHERE id=?');
      for (const txnId of txnIds) {
        const sale = getSale.get(txnId);
        if (sale && sale.status === 'pending') {
          deleteItems.run(sale.id);
          deleteSale.run(sale.id);
          removed++;
        }
      }
    })();
    for (const txnId of txnIds) pendingSaleOwners.delete(txnId);
    return removed;
  };

  // ---- Create a sale (PENDING — stock not yet deducted) -----------------
  // The sale is recorded with status='pending'.  Stock is NOT deducted,
  // no stock movements are written, and contractor credit is NOT increased
  // until the cashier clicks PRINT on the receipt modal (pos:sales:commit).
  // If the receipt modal is closed without printing, the pending sale is
  // voided (pos:sales:void) and removed entirely.
  guard(ipcMain, 'pos:sales:create', { auth: true }, ({ session, token }, payload) => {
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

    // Customer / On-Account credit. A date-only Due Date is persisted on
    // the pending sale so the Loan can be created atomically at commit time.
    let customer = null;
    if (p.customerId) customer = db.prepare('SELECT * FROM customers WHERE id=?').get(p.customerId);
    const customerName = customer ? customer.name : (p.customerName || 'Walk-in Customer');
    let dueDate = null;
    if (paymentMethod === 'account') {
      if (!customer || customer.type !== 'contractor' || !Number(customer.active)) {
        throw new Error('On-account requires an active credit customer');
      }
      dueDate = validateNewDueDate(p.dueDate);
      if (Number(customer.credit_used) + totals.total > Number(customer.credit_limit) + 1e-9) {
        throw new Error('Exceeds credit limit');
      }
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
        'amount_tendered','change','reference','due_date','status'];
      const args = ['PENDING', 0, datetime, session.id, session.full_name, p.customerId || null, customerName,
        p.project || null, p.poNumber || null, totals.subtotal, totals.vat, discount,
        deliveryFee, totals.total, paymentMethod, tendered, change, p.reference || null,
        dueDate, 'pending'];
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

    pendingSaleOwners.set(result.txnId, token);
    const receipt = buildReceipt(db, result.saleId);
    return { ...result, receipt };
  });

  // ---- Commit a pending sale (PRINT clicked → deduct stock) -------------
  // Deducts stock, writes stock movements, updates contractor credit, and
  // marks the sale status='completed'.  Throws if the sale is not pending.
  guard(ipcMain, 'pos:sales:commit', { auth: true }, ({ session, token }, txnId) => {
    const sale = db.prepare('SELECT * FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) throw new Error('Sale not found: ' + txnId);
    if (sale.status !== 'pending') throw new Error('Sale is not pending (already ' + sale.status + ')');
    assertPendingSaleOwner(txnId, token);
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
        const customer = db.prepare('SELECT type,active,credit_limit,credit_used FROM customers WHERE id=?').get(sale.customer_id);
        if (!customer || customer.type !== 'contractor' || !Number(customer.active)) {
          throw new Error('On-account customer is no longer available');
        }
        if (Number(customer.credit_used) + Number(sale.total) > Number(customer.credit_limit) + 1e-9) {
          throw new Error('Exceeds credit limit');
        }
      }
      const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
      const movStmt = db.prepare('INSERT INTO stock_movements(product_id,movement,qty_change,reason,user_id) VALUES(?,?,?,?,?)');
      for (const it of items) {
        if (it.line_type === 'service' || !it.product_id) continue;
        decStock.run(it.stock_consumed, it.product_id);
        movStmt.run(it.product_id, 'sale', -it.stock_consumed, 'Sale ' + txnId, session.id);
      }
      db.prepare("UPDATE sales SET status='completed' WHERE id=?").run(sale.id);
      if (sale.payment_method === 'account' && sale.customer_id) {
        createSaleLoan(db, sale, session);
        reconcileCustomerCredit(db, sale.customer_id);
      }
    })();

    pendingSaleOwners.delete(txnId);
    return { ok: true, txnId, status: 'completed' };
  });

  // ---- Void a pending sale (closed without printing → delete) -----------
  // Deletes the pending sale and its items.  No stock was deducted at
  // create time, so nothing needs to be restocked.  Completed sales cannot
  // be voided (use the refund flow instead).
  guard(ipcMain, 'pos:sales:void', { auth: true }, ({ token }, txnId) => {
    const sale = db.prepare('SELECT id FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) throw new Error('Sale not found: ' + txnId);
    const cur = db.prepare('SELECT status FROM sales WHERE id=?').get(sale.id);
    if (cur.status !== 'pending') throw new Error('Cannot void a ' + cur.status + ' sale (use refund instead)');
    assertPendingSaleOwner(txnId, token);
    db.transaction(() => {
      db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(sale.id);
      db.prepare('DELETE FROM sales WHERE id=?').run(sale.id);
    })();
    pendingSaleOwners.delete(txnId);
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

      // Cancel only the linked Loan's remaining balance. Prior payments stay
      // visible for audit, and the customer aggregate is reconciled from all
      // other open Loans so a refund can never create a negative balance.
      if (sale.payment_method === 'account' && sale.customer_id) {
        cancelSaleLoan(db, sale.id, { id: adminId, full_name: adminName }, reason);
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
  // Wipes sales and all dependent stock/refund/Loan ledger history while
  // preserving users, products, customer profiles, categories, and settings.
  guard(ipcMain, 'pos:sales:reset', { admin: true }, () => {
    // A destructive reset must not remove/reuse Loan ids while an asynchronous
    // Telegram delivery is in flight; ask the administrator to retry instead.
    require('../lib/loan-reminders').assertLoanReminderRunIdle('reset sales');
    const tx = db.transaction(() => {
      // Delete in explicit child-first order because the sql.js shim cannot
      // be relied on to enforce every foreign-key cascade.
      db.exec('DELETE FROM loan_reminders;');
      db.exec('DELETE FROM loan_events;');
      db.exec('DELETE FROM loan_payments;');
      db.exec('DELETE FROM loans;');
      db.exec('DELETE FROM sale_items;');
      db.exec('DELETE FROM refunds;');
      db.exec('DELETE FROM stock_movements;');
      db.exec('DELETE FROM sales;');
      const resetTables = [
        'loan_reminders','loan_events','loan_payments','loans',
        'sales','sale_items','refunds','stock_movements',
      ];
      db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${resetTables.map(() => '?').join(',')})`)
        .run(...resetTables);
      db.prepare("UPDATE products SET stock = 0 WHERE is_service = 0 OR is_service IS NULL").run();
      db.prepare("UPDATE customers SET credit_used = 0,updated_at=datetime('now')").run();
    });
    tx();
    clearPendingSaleOwners();
    return { ok: true };
  });

  return { discardPendingSalesForToken, clearPendingSaleOwners };
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
