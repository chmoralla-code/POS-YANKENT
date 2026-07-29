'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { round2 } = require('../lib/money');
const {
  buildMarginWorkbook,
  buildMarginPdfHtml,
} = require('../lib/margin-exports');

const CATEGORY_NAME = 'Newly Added Items';
const MAX_SOURCE_LENGTH = 200;
const MAX_ITEM_NAME_LENGTH = 200;
const MAX_UNIT_LENGTH = 32;
const MARGIN_RULES = Object.freeze([
  Object.freeze({ min_exclusive: null, max_inclusive: 100, unit_profit: 10 }),
  Object.freeze({ min_exclusive: 100, max_inclusive: 200, unit_profit: 15 }),
  Object.freeze({ min_exclusive: 200, max_inclusive: null, unit_profit: 20 }),
]);

function unitProfitFor(price) {
  if (price <= 100) return 10;
  if (price <= 200) return 15;
  return 20;
}

function normalizeSource(value) {
  const source = String(value == null ? '' : value).trim();
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`Purchase source cannot exceed ${MAX_SOURCE_LENGTH} characters`);
  }
  return source;
}

function normalizeProductId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid product');
  return id;
}

function normalizeOriginalCost(value, sellingPrice) {
  if (value === '' || value == null) {
    throw new Error('Enter the original price (puhunan)');
  }
  const cost = round2(Number(value));
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error('Original price must be zero or greater');
  }
  const price = round2(Number(sellingPrice));
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Selling price must be greater than zero');
  }
  if (cost >= price) {
    throw new Error('Original price must be lower than the selling price');
  }
  return cost;
}

function normalizeRequiredText(value, label, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) {
    throw new Error(`${label} cannot exceed ${maxLength} characters`);
  }
  return text;
}

function normalizePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return number;
}

function normalizeNonNegativeNumber(value, label, fallback = 0) {
  const raw = value === '' || value == null ? fallback : value;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be zero or greater`);
  }
  return number;
}

function eligibleRows(db) {
  return db.prepare(`
    SELECT p.id, p.sku, p.name, p.base_unit AS unit, p.stock,
           p.purchase_source, p.price AS selling_price, p.margin_original_cost
      FROM products p
      JOIN categories c ON c.id = p.category_id
     WHERE c.name = ?
       AND p.active = 1
       AND p.is_service = 0
       AND p.stock > 0
     ORDER BY p.name COLLATE NOCASE, p.id
  `).all(CATEGORY_NAME);
}

function computedRow(row) {
  const price = round2(Number(row.selling_price));
  const stock = Number(row.stock);
  const source = String(row.purchase_source == null ? '' : row.purchase_source).trim();
  const priceOk = Number.isFinite(price) && price > 0;
  const autoProfit = priceOk ? unitProfitFor(price) : null;
  const canAutoCost = priceOk && price >= autoProfit;
  const rawManual = row.margin_original_cost;
  const hasManual = rawManual != null && rawManual !== '' && Number.isFinite(Number(rawManual));
  const manualCost = hasManual ? round2(Number(rawManual)) : null;
  const manualUsable = hasManual && priceOk && manualCost >= 0 && manualCost < price;

  let computedCost = null;
  let unitProfit = autoProfit;
  let needsManualCost = false;
  let costMode = 'auto';

  if (manualUsable) {
    // Administrator override (including under-₱10 items and corrections).
    computedCost = manualCost;
    unitProfit = round2(price - manualCost);
    costMode = 'manual';
    needsManualCost = false;
  } else if (canAutoCost) {
    computedCost = round2(price - autoProfit);
    unitProfit = autoProfit;
    costMode = 'auto';
  } else if (priceOk) {
    // Selling price is below the fixed margin (e.g. under ₱10) — puhunan
    // must be entered by the administrator after generate.
    needsManualCost = true;
    computedCost = null;
    unitProfit = null;
    costMode = 'pending';
  }

  const priceValid = priceOk;
  return {
    id: Number(row.id),
    sku: String(row.sku || ''),
    name: String(row.name || ''),
    unit: String(row.unit || ''),
    stock,
    purchase_source: source,
    selling_price: priceOk ? price : null,
    unit_profit: unitProfit,
    computed_cost: computedCost,
    potential_gross_profit: computedCost != null && unitProfit != null
      ? round2(stock * unitProfit)
      : null,
    source_missing: !source,
    price_valid: priceValid,
    needs_manual_cost: needsManualCost,
    cost_mode: costMode,
    price_error: priceValid
      ? null
      : 'Selling price must be greater than zero',
  };
}

function createMarginItem(db, payload = {}, session = null) {
  const category = db.prepare('SELECT id FROM categories WHERE name=?').get(CATEGORY_NAME);
  if (!category) {
    throw new Error(`The "${CATEGORY_NAME}" category is missing`);
  }

  const name = normalizeRequiredText(payload.name, 'Item name', MAX_ITEM_NAME_LENGTH);
  const unit = normalizeRequiredText(
    payload.base_unit != null ? payload.base_unit : payload.unit,
    'Unit',
    MAX_UNIT_LENGTH
  );
  const stock = normalizePositiveNumber(payload.stock, 'Stock');
  const price = round2(normalizePositiveNumber(
    payload.selling_price != null ? payload.selling_price : payload.price,
    'Selling price'
  ));
  const source = normalizeSource(
    payload.purchase_source != null ? payload.purchase_source : payload.source
  );
  if (!source) throw new Error('Place where bought is required');
  const lowStock = normalizeNonNegativeNumber(
    payload.low_stock_threshold,
    'Low-stock threshold',
    10
  );

  const rawOriginalCost = payload.original_cost != null
    ? payload.original_cost
    : payload.margin_original_cost;
  const hasOriginalCost = rawOriginalCost !== '' && rawOriginalCost != null;
  const automaticProfit = unitProfitFor(price);
  if (!hasOriginalCost && price < automaticProfit) {
    throw new Error(
      `Original price (puhunan) is required when the selling price is below ₱${automaticProfit}`
    );
  }
  const originalCost = hasOriginalCost
    ? normalizeOriginalCost(rawOriginalCost, price)
    : null;
  const syncedCost = originalCost == null
    ? round2(price - automaticProfit)
    : originalCost;

  const duplicate = db.prepare(
    'SELECT id FROM products WHERE active=1 AND LOWER(TRIM(name))=LOWER(?) LIMIT 1'
  ).get(name);
  if (duplicate) throw new Error('An active product with this name already exists');

  const productId = db.transaction(() => {
    let next = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM products').get().n);
    let sku = '';
    do {
      sku = 'P-' + String(next).padStart(5, '0');
      next += 1;
    } while (db.prepare('SELECT id FROM products WHERE sku=?').get(sku));

    const inserted = db.prepare(
      `INSERT INTO products(
         sku,name,category_id,base_unit,stock,cost,price,purchase_source,
         margin_original_cost,low_stock_threshold,is_service,active
       ) VALUES(?,?,?,?,?,?,?,?,?,?,0,1)`
    ).run(
      sku,
      name,
      category.id,
      unit,
      stock,
      syncedCost,
      price,
      source,
      originalCost,
      lowStock
    );
    const id = Number(inserted.lastInsertRowid);
    db.prepare(
      'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,1,?)'
    ).run(id, unit, price);
    db.prepare(
      `INSERT INTO stock_movements(
         product_id,movement,qty_change,reason,user_id,source_location
       ) VALUES(?,'restock',?,?,?,?)`
    ).run(
      id,
      stock,
      'Initial stock (Margin Table Add Item)',
      session && session.id ? session.id : null,
      source
    );
    return id;
  })();

  const row = eligibleRows(db).map(computedRow)
    .find((entry) => Number(entry.id) === productId);
  if (!row) throw new Error('The new item could not be loaded into the margin table');
  return {
    id: productId,
    category: CATEGORY_NAME,
    row,
  };
}

function buildReadiness(db) {
  const category = db.prepare('SELECT id FROM categories WHERE name=?').get(CATEGORY_NAME);
  const rows = eligibleRows(db).map(computedRow);
  const missingSourceCount = rows.filter((row) => row.source_missing).length;
  const invalidPriceCount = rows.filter((row) => !row.price_valid).length;
  const manualCostCount = rows.filter((row) => row.needs_manual_cost).length;
  const completedCount = rows.filter((row) => !row.source_missing && row.price_valid).length;
  return {
    category: CATEGORY_NAME,
    categoryFound: !!category,
    rules: MARGIN_RULES.map((rule) => ({ ...rule })),
    eligibleCount: rows.length,
    completedCount,
    missingSourceCount,
    invalidPriceCount,
    manualCostCount,
    canGenerate: rows.length > 0 && missingSourceCount === 0 && invalidPriceCount === 0,
    rows,
  };
}

function assertEligibleProduct(db, id) {
  const row = db.prepare(`
    SELECT p.id, p.price
      FROM products p
      JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?
       AND c.name = ?
       AND p.active = 1
       AND p.is_service = 0
       AND p.stock > 0
  `).get(id, CATEGORY_NAME);
  if (!row) throw new Error('Product is not eligible for the Product Margin Table');
  return row;
}

function notReadyError(readiness) {
  let message;
  if (!readiness.eligibleCount) {
    message = `No active, in-stock products were found in "${CATEGORY_NAME}"`;
  } else {
    const issues = [];
    if (readiness.missingSourceCount) {
      issues.push(`${readiness.missingSourceCount} purchase place${readiness.missingSourceCount === 1 ? '' : 's'}`);
    }
    if (readiness.invalidPriceCount) {
      issues.push(`${readiness.invalidPriceCount} invalid selling price${readiness.invalidPriceCount === 1 ? '' : 's'}`);
    }
    message = `Complete or correct ${issues.join(' and ')} before generating the table`;
  }
  const error = new Error(message);
  error.code = 'MARGIN_TABLE_NOT_READY';
  return error;
}

function generateTable(db) {
  const readiness = buildReadiness(db);
  if (!readiness.canGenerate) throw notReadyError(readiness);

  const rows = readiness.rows.map((row) => ({ ...row }));
  rows.sort((a, b) => {
    const rank = (row) => {
      if (row.needs_manual_cost || row.computed_cost == null) return 0;
      if (row.selling_price != null && row.selling_price < 10) return 1;
      return 2;
    };
    const diff = rank(a) - rank(b);
    if (diff) return diff;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });

  const summary = rows.reduce((totals, row) => {
    totals.total_stock += row.stock;
    if (row.selling_price != null) {
      totals.retail_value += round2(row.stock * row.selling_price);
    }
    if (row.computed_cost != null) {
      totals.computed_cost += round2(row.stock * row.computed_cost);
    }
    if (row.potential_gross_profit != null) {
      totals.potential_gross_profit += row.potential_gross_profit;
    }
    if (row.needs_manual_cost) totals.missing_cost_count += 1;
    return totals;
  }, {
    item_count: rows.length,
    total_stock: 0,
    retail_value: 0,
    computed_cost: 0,
    potential_gross_profit: 0,
    missing_cost_count: 0,
  });
  summary.total_stock = round2(summary.total_stock);
  summary.retail_value = round2(summary.retail_value);
  summary.computed_cost = round2(summary.computed_cost);
  summary.potential_gross_profit = round2(summary.potential_gross_profit);

  return {
    category: CATEGORY_NAME,
    generatedAt: new Date().toISOString(),
    rules: readiness.rules,
    summary,
    rows,
  };
}

function dateStamp(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function ensureExtension(filePath, extension) {
  return filePath.toLocaleLowerCase().endsWith(extension)
    ? filePath
    : `${filePath}${extension}`;
}

async function chooseExportPath(ctx, extension, label) {
  const result = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
    title: `Save Generate Margin Table as ${label}`,
    defaultPath: `yankent-margin-table-${dateStamp()}${extension}`,
    filters: [{ name: label, extensions: [extension.slice(1)] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  return ensureExtension(result.filePath, extension);
}

async function writePdf(ctx, filePath, report) {
  const tempPath = path.join(
    os.tmpdir(),
    `yankent-margin-table-${randomUUID()}.html`
  );
  let printWindow = null;
  try {
    await fs.promises.writeFile(tempPath, buildMarginPdfHtml(report), 'utf8');
    printWindow = new ctx.BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await printWindow.loadFile(tempPath);
    const pdf = await printWindow.webContents.printToPDF({
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
    });
    await fs.promises.writeFile(filePath, pdf);
  } finally {
    if (printWindow) {
      const alive = typeof printWindow.isDestroyed !== 'function'
        || !printWindow.isDestroyed();
      if (alive && typeof printWindow.destroy === 'function') printWindow.destroy();
      else if (alive && typeof printWindow.close === 'function') printWindow.close();
    }
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function register(ipcMain, ctx) {
  const { db, guard } = ctx;

  guard(ipcMain, 'pos:margins:readiness', { admin: true }, () => buildReadiness(db));

  guard(ipcMain, 'pos:margins:addItem', { admin: true }, ({ session }, payload) =>
    createMarginItem(db, payload, session)
  );

  guard(ipcMain, 'pos:margins:setSource', { admin: true }, (_c, productId, value) => {
    const id = normalizeProductId(productId);
    const source = normalizeSource(value);
    assertEligibleProduct(db, id);
    db.prepare('UPDATE products SET purchase_source=? WHERE id=?').run(source || null, id);
    return { id, purchase_source: source };
  });

  guard(ipcMain, 'pos:margins:bulkSetSource', { admin: true }, (_c, productIds, value) => {
    if (!Array.isArray(productIds) || !productIds.length) {
      throw new Error('Select at least one product');
    }
    if (productIds.length > 10000) throw new Error('Too many products selected');
    const ids = [...new Set(productIds.map(normalizeProductId))];
    const source = normalizeSource(value);
    const update = db.prepare('UPDATE products SET purchase_source=? WHERE id=?');
    db.transaction(() => {
      for (const id of ids) assertEligibleProduct(db, id);
      for (const id of ids) update.run(source || null, id);
    })();
    return { updated: ids.length, purchase_source: source };
  });

  guard(ipcMain, 'pos:margins:setOriginalCost', { admin: true }, (_c, productId, value) => {
    const id = normalizeProductId(productId);
    const product = assertEligibleProduct(db, id);
    const cost = normalizeOriginalCost(value, product.price);
    db.prepare('UPDATE products SET margin_original_cost=? WHERE id=?').run(cost, id);
    const refreshed = eligibleRows(db).find((entry) => Number(entry.id) === id);
    return {
      id,
      margin_original_cost: cost,
      row: computedRow(refreshed),
    };
  });

  guard(ipcMain, 'pos:margins:generate', { admin: true }, () => generateTable(db));

  guard(ipcMain, 'pos:margins:exportExcel', { admin: true }, async () => {
    const report = generateTable(db);
    const filePath = await chooseExportPath(ctx, '.xlsx', 'Excel Workbook');
    if (!filePath) return { canceled: true };
    const workbook = await buildMarginWorkbook(report);
    await fs.promises.writeFile(filePath, workbook);
    return { canceled: false, filePath };
  });

  guard(ipcMain, 'pos:margins:exportPdf', { admin: true }, async () => {
    const report = generateTable(db);
    const filePath = await chooseExportPath(ctx, '.pdf', 'PDF Document');
    if (!filePath) return { canceled: true };
    await writePdf(ctx, filePath, report);
    return { canceled: false, filePath };
  });
}

module.exports = {
  register,
  buildReadiness,
  generateTable,
  createMarginItem,
  unitProfitFor,
  CATEGORY_NAME,
  MARGIN_RULES,
  dateStamp,
  ensureExtension,
  chooseExportPath,
  writePdf,
};
