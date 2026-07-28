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
  buildMarginWorkbook,
  buildMarginPdfHtml,
  TABLE_HEADERS,
  PHP_NUMBER_FORMAT,
} = require('../src/main/lib/margin-exports');

function sampleReport() {
  return {
    category: 'Newly Added Items',
    generatedAt: '2026-07-28T04:30:00.000Z',
    rules: [
      { min_exclusive: null, max_inclusive: 100, unit_profit: 10 },
      { min_exclusive: 100, max_inclusive: 200, unit_profit: 15 },
      { min_exclusive: 200, max_inclusive: null, unit_profit: 20 },
    ],
    summary: {
      item_count: 2,
      total_stock: 5.5,
      retail_value: 820,
      computed_cost: 750,
      potential_gross_profit: 70,
    },
    rows: [
      {
        name: 'PVC Elbow <1/2">',
        unit: 'pc',
        stock: 4,
        purchase_source: 'Cyrhiel & Sons',
        computed_cost: 90,
        selling_price: 100,
        unit_profit: 10,
        potential_gross_profit: 40,
      },
      {
        name: 'Steel Bar',
        unit: 'kg',
        stock: 1.5,
        purchase_source: '"Main" Depot',
        computed_cost: 260,
        selling_price: 280,
        unit_profit: 20,
        potential_gross_profit: 30,
      },
    ],
  };
}

test('margin workbook contains a typed, formatted and filterable report table', async () => {
  const buffer = await buildMarginWorkbook(sampleReport());
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 5000);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Product Margin Table');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A1').value, 'YANKENT POS');
  assert.equal(sheet.getCell('A2').value, 'PRODUCT MARGIN TABLE');
  assert.equal(sheet.getCell('E3').value, 'Jul 28, 2026, 12:30:00 PM (Asia/Manila)');

  const table = sheet.getTable('MarginTable');
  assert.ok(table);
  assert.deepEqual(table.table.columns.map((column) => column.name), [...TABLE_HEADERS]);
  assert.equal(sheet.getCell('A12').value, 'PVC Elbow <1/2">');
  assert.equal(sheet.getCell('B12').value, 4);
  assert.equal(sheet.getCell('C12').value, 'Cyrhiel & Sons');
  assert.equal(sheet.getCell('D12').value, 90);
  assert.equal(sheet.getCell('E12').value, 100);
  assert.equal(sheet.getCell('F12').value, 40);
  assert.equal(sheet.getCell('E12').numFmt, PHP_NUMBER_FORMAT);
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.ok(sheet.views.some((view) => view.state === 'frozen'));
});

test('margin PDF HTML is self-contained and escapes database text', () => {
  const html = buildMarginPdfHtml(sampleReport());
  assert.match(html, /@page\s*{\s*size: A4 landscape/);
  assert.match(html, /<thead>/);
  assert.match(html, /Profit \/ Gross/);
  assert.match(html, /Original Price/);
  assert.match(html, /Place Where Bought/);
  assert.match(html, /PVC Elbow &lt;1\/2&quot;&gt;/);
  assert.match(html, /Cyrhiel &amp; Sons/);
  assert.match(html, /&quot;Main&quot; Depot/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('admin export handlers save XLSX and PDF files and clean up print HTML', async () => {
  const base = path.join(
    os.tmpdir(),
    `yankent-margin-export-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const xlsxPathWithoutExtension = `${base}-workbook`;
  const pdfPathWithoutExtension = `${base}-report`;
  let loadedTempPath = '';
  let destroyed = false;

  function FakeBrowserWindow() {
    this.loadFile = async (filePath) => {
      loadedTempPath = filePath;
      assert.equal(fs.existsSync(filePath), true);
    };
    this.webContents = {
      printToPDF: async (options) => {
        assert.equal(options.landscape, true);
        assert.equal(options.printBackground, true);
        assert.equal(options.preferCSSPageSize, true);
        return Buffer.from('%PDF-1.4\nfake margin report\n%%EOF');
      },
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
  const category = api.db.prepare(
    "SELECT id FROM categories WHERE name='Newly Added Items'"
  ).get();
  api.db.prepare('UPDATE products SET active=0 WHERE category_id=?').run(category.id);
  api.db.prepare(
    `INSERT INTO products(
       sku,name,category_id,base_unit,stock,cost,price,purchase_source,
       low_stock_threshold,is_service,active
     ) VALUES(?,?,?,?,?,?,?,?,0,0,1)`
  ).run('EXPORT-1', 'Export Item', category.id, 'pc', 2, 0, 100, 'Supplier');

  try {
    const xlsxResult = await api.call('pos:margins:exportExcel', session);
    assert.equal(xlsxResult.filePath, `${xlsxPathWithoutExtension}.xlsx`);
    assert.ok(fs.statSync(xlsxResult.filePath).size > 5000);

    const pdfResult = await api.call('pos:margins:exportPdf', session);
    assert.equal(pdfResult.filePath, `${pdfPathWithoutExtension}.pdf`);
    assert.match(fs.readFileSync(pdfResult.filePath, 'utf8'), /^%PDF-1\.4/);
    assert.ok(loadedTempPath);
    assert.equal(fs.existsSync(loadedTempPath), false);
    assert.equal(destroyed, true);
  } finally {
    api.close();
    for (const filePath of [
      `${xlsxPathWithoutExtension}.xlsx`,
      `${pdfPathWithoutExtension}.pdf`,
    ]) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
});
