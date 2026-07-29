'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const {
  buildMarginReportWorkbook,
  buildMarginReportPdfHtml,
  REPORT_HEADERS,
} = require('../src/main/lib/margin-report-exports');
const { generateReport } = require('../src/main/ipc/margin-reports');

async function setup() {
  const api = await makeApi();
  const admin = api.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const cashier = api.db.prepare("SELECT * FROM users WHERE username='cashier'").get();
  return {
    api,
    adminSession: createSession(admin),
    cashierSession: createSession(cashier),
  };
}

async function makeSale(api, session, {
  productId, sku, name, unit = 'bag', qty, unitPrice, factor = 1,
  discount = 0,
  paymentMethod = 'cash',
  customerId = null,
  customerName = '',
}) {
  const due = new Date();
  due.setDate(due.getDate() + 7);
  const res = await api.call('pos:sales:create', session, {
    items: [{
      productId, sku, name, unit, qty, unitPrice, factor,
    }],
    discount,
    paymentMethod,
    customerId,
    customerName,
    dueDate: paymentMethod === 'account' ? due.toISOString().slice(0, 10) : undefined,
    amountTendered: paymentMethod === 'cash' ? 99999 : 0,
  });
  await api.call('pos:sales:commit', session, res.txnId);
  return res;
}

function sampleReport() {
  return {
    period: 'today',
    label: 'Today',
    generatedAt: '2026-07-29T01:00:00.000Z',
    rows: [
      {
        name: 'Cement Bag',
        qty_sold: 2,
        stock: 10,
        is_service: false,
        puhunan: 180,
        baligya: 200,
        halin: 20,
      },
      {
        name: 'Delivery Fee',
        qty_sold: 1,
        stock: null,
        is_service: true,
        puhunan: 80,
        baligya: 100,
        halin: 20,
        needs_manual_cost: false,
      },
    ],
    totals: {
      item_count: 2,
      qty_sold: 3,
      puhunan: 260,
      baligya: 300,
      halin: 40,
      missing_cost_count: 0,
    },
  };
}

test('margin report generate is administrator-only', async () => {
  const t = await setup();
  await assert.rejects(
    () => t.api.call('pos:marginReports:generate', t.cashierSession, 'today'),
    /Administrator access required/
  );
  t.api.close();
});

test('margin report totals use catalog margin rules times qty sold', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, price, stock, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  assert.ok(product, 'seed cement product required');

  // Ensure catalog price 280 → unit cost 260 (₱20 band).
  t.api.db.prepare('UPDATE products SET price=280, margin_original_cost=NULL WHERE id=?')
    .run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=280 WHERE product_id=?')
    .run(product.id);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 2,
    unitPrice: 280,
  });

  const report = await t.api.call('pos:marginReports:generate', t.adminSession, 'today');
  assert.equal(report.period, 'today');
  assert.equal(report.label, 'Today');
  assert.ok(report.rows.length >= 1);

  const row = report.rows.find((r) => Number(r.product_id) === Number(product.id));
  assert.ok(row);
  assert.equal(row.qty_sold, 2);
  assert.equal(row.unit_cost, 260);
  assert.equal(row.puhunan, 520);
  assert.equal(row.baligya, 560);
  assert.equal(row.halin, 40);
  assert.equal(report.totals.baligya, row.baligya);
  assert.equal(report.totals.puhunan, row.puhunan);
  assert.equal(report.totals.halin, row.halin);
  t.api.close();
});

test('Margin table Reports follows the Analytics Separate switch', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  const customer = t.api.db.prepare(
    "SELECT id, name FROM customers WHERE name='ABC Construction'"
  ).get();
  t.api.db.prepare('UPDATE products SET price=100, margin_original_cost=NULL WHERE id=?')
    .run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=100 WHERE product_id=?')
    .run(product.id);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 1,
    unitPrice: 100,
  });
  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 2,
    unitPrice: 100,
    paymentMethod: 'account',
    customerId: customer.id,
    customerName: customer.name,
  });

  const combined = await t.api.call(
    'pos:marginReports:generate',
    t.adminSession,
    'today'
  );
  assert.equal(combined.separateUtang, false);
  assert.equal(combined.rows[0].qty_sold, 3);
  assert.equal(combined.totals.baligya, 300);
  assert.equal(combined.totals.halin, 30);

  await t.api.call(
    'pos:reports:setUtangSeparation',
    t.adminSession,
    true
  );
  const separated = await t.api.call(
    'pos:marginReports:generate',
    t.adminSession,
    'today'
  );
  assert.equal(separated.separateUtang, true);
  assert.equal(separated.rows[0].qty_sold, 1);
  assert.equal(separated.totals.baligya, 100);
  assert.equal(separated.totals.halin, 10);

  await t.api.call(
    'pos:reports:setUtangSeparation',
    t.adminSession,
    false
  );
  const restored = await t.api.call(
    'pos:marginReports:generate',
    t.adminSession,
    'today'
  );
  assert.equal(restored.rows[0].qty_sold, 3);
  assert.equal(restored.totals.baligya, 300);
  t.api.close();
});

test('alternate units and sale discounts use consumed stock cost and net sales', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  assert.ok(product, 'seed cement product required');

  t.api.db.prepare("UPDATE settings SET value='10' WHERE key='discount_percent'").run();
  t.api.db.prepare(
    'UPDATE products SET price=100, margin_original_cost=NULL, stock=100 WHERE id=?'
  ).run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=100 WHERE product_id=? AND factor=1')
    .run(product.id);
  t.api.db.prepare(
    'INSERT INTO product_units(product_id,unit,factor,price) VALUES(?,?,?,?)'
  ).run(product.id, 'box', 10, 1000);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: 'box',
    qty: 1,
    unitPrice: 1000,
    factor: 10,
    discount: 100,
  });

  const report = await t.api.call('pos:marginReports:generate', t.adminSession, 'today');
  const row = report.rows.find((r) => Number(r.product_id) === Number(product.id));
  assert.ok(row);
  assert.equal(row.qty_sold, 1);
  assert.equal(row.stock, 90);
  assert.equal(row.unit_cost, 90);
  assert.equal(row.puhunan, 900);
  assert.equal(row.baligya, 900);
  assert.equal(row.halin, 0);
  assert.equal(report.totals.puhunan, 900);
  assert.equal(report.totals.baligya, 900);
  assert.equal(report.totals.halin, 0);
  t.api.close();
});

test('margin report yesterday period only includes yesterday sales', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  t.api.db.prepare('UPDATE products SET price=100, margin_original_cost=NULL WHERE id=?')
    .run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=100 WHERE product_id=?')
    .run(product.id);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 1,
    unitPrice: 100,
  });
  const yesterdaySale = await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 3,
    unitPrice: 100,
  });
  t.api.db.prepare(
    `UPDATE sales SET datetime=datetime('now','localtime','-1 day') WHERE txn_id=?`
  ).run(yesterdaySale.txnId);

  const today = await t.api.call('pos:marginReports:generate', t.adminSession, 'today');
  const yesterday = await t.api.call('pos:marginReports:generate', t.adminSession, 'yesterday');

  const todayRow = today.rows.find((r) => Number(r.product_id) === Number(product.id));
  const yRow = yesterday.rows.find((r) => Number(r.product_id) === Number(product.id));
  assert.equal(todayRow.qty_sold, 1);
  assert.equal(todayRow.baligya, 100);
  assert.equal(yRow.qty_sold, 3);
  assert.equal(yRow.baligya, 300);
  assert.equal(yRow.puhunan, 270); // (100-10)*3
  t.api.close();
});

test('today period includes sales stored with local machine datetime', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit, price FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 1,
    unitPrice: product.price,
  });

  const today = await t.api.call('pos:marginReports:generate', t.adminSession, 'today');
  assert.equal(
    today.rows.some((row) => Number(row.product_id) === Number(product.id)),
    true
  );
  t.api.close();
});

test('manual margin_original_cost is preferred for report puhunan', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  t.api.db.prepare('UPDATE products SET price=100, margin_original_cost=85 WHERE id=?')
    .run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=100 WHERE product_id=?')
    .run(product.id);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 2,
    unitPrice: 100,
  });

  const report = generateReport(t.api.db, 'today');
  const row = report.rows.find((r) => Number(r.product_id) === Number(product.id));
  assert.equal(row.unit_cost, 85);
  assert.equal(row.puhunan, 170);
  assert.equal(row.halin, 30);
  t.api.close();
});

test('pending manual cost blanks puhunan/halin and excludes them from those totals', async () => {
  const t = await setup();
  const product = t.api.db.prepare(
    "SELECT id, sku, name, base_unit FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  // Under ₱10 with no manual cost → pending.
  t.api.db.prepare('UPDATE products SET price=8, margin_original_cost=NULL WHERE id=?')
    .run(product.id);
  t.api.db.prepare('UPDATE product_units SET price=8 WHERE product_id=?')
    .run(product.id);

  await makeSale(t.api, t.cashierSession, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.base_unit || 'bag',
    qty: 1,
    unitPrice: 8,
  });

  const report = await t.api.call('pos:marginReports:generate', t.adminSession, 'today');
  const row = report.rows.find((r) => Number(r.product_id) === Number(product.id));
  assert.equal(row.needs_manual_cost, true);
  assert.equal(row.puhunan, null);
  assert.equal(row.halin, null);
  assert.equal(row.baligya, 8);
  assert.equal(report.totals.baligya, 8);
  assert.equal(report.totals.puhunan, 0);
  assert.equal(report.totals.halin, 0);
  assert.ok(report.totals.missing_cost_count >= 1);
  t.api.close();
});

test('margin report workbook and PDF include period, columns, and totals', async () => {
  const buffer = await buildMarginReportWorkbook(sampleReport());
  assert.ok(Buffer.isBuffer(buffer));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Margin table Reports');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A2').value, 'MARGIN TABLE REPORTS');
  assert.equal(sheet.getCell('B3').value, 'Today');
  assert.equal(sheet.getCell('B6').value, 'All completed sales — Utang included');
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((column) => sheet.getCell(8, column).value),
    [...REPORT_HEADERS]
  );
  assert.equal(sheet.getCell('A9').value, 'Cement Bag');
  assert.equal(sheet.getCell('B9').value, 2);
  assert.equal(sheet.getCell('D9').value, 180);
  assert.equal(sheet.getCell('A11').value, 'TOTAL');
  assert.equal(sheet.getCell('E11').value, 300);
  assert.equal(sheet.getCell('F11').value, 40);

  const html = buildMarginReportPdfHtml(sampleReport());
  assert.match(html, /Margin table Reports/);
  assert.match(html, /Today/);
  assert.match(html, /All completed sales — Utang included/);
  assert.match(html, /Cement Bag/);
  assert.match(html, /TOTAL/);
  assert.doesNotMatch(html, /<script/i);
});

test('margin report export handlers save files', async () => {
  const base = path.join(
    os.tmpdir(),
    `yankent-mrep-export-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const xlsxPathWithoutExtension = `${base}-workbook`;
  const pdfPathWithoutExtension = `${base}-report`;
  let destroyed = false;

  function FakeBrowserWindow() {
    this.loadFile = async () => {};
    this.webContents = {
      printToPDF: async () => Buffer.from('%PDF-1.4\nfake\n%%EOF'),
    };
    this.isDestroyed = () => destroyed;
    this.destroy = () => { destroyed = true; };
  }

  const api = await makeApi({
    dialog: {
      showSaveDialog: async (_window, options) => ({
        canceled: false,
        filePath: options.filters[0].extensions[0] === 'xlsx'
          ? xlsxPathWithoutExtension
          : pdfPathWithoutExtension,
      }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    BrowserWindow: FakeBrowserWindow,
  });

  const admin = api.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const session = createSession(admin);
  const product = api.db.prepare(
    "SELECT id, sku, name, price FROM products WHERE sku='CMT-001' AND active=1"
  ).get();
  await makeSale(api, session, {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    qty: 1,
    unitPrice: product.price,
  });

  const xlsxResult = await api.call('pos:marginReports:exportExcel', session, 'today');
  assert.equal(xlsxResult.canceled, false);
  assert.ok(fs.existsSync(xlsxResult.filePath));
  assert.match(xlsxResult.filePath, /\.xlsx$/i);

  const pdfResult = await api.call('pos:marginReports:exportPdf', session, 'today');
  assert.equal(pdfResult.canceled, false);
  assert.ok(fs.existsSync(pdfResult.filePath));
  assert.match(pdfResult.filePath, /\.pdf$/i);

  fs.unlinkSync(xlsxResult.filePath);
  fs.unlinkSync(pdfResult.filePath);
  api.close();
});
