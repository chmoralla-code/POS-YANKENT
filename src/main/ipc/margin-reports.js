'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { round2 } = require('../lib/money');
const {
  MARGIN_RULES,
  resolveUnitCost,
} = require('../lib/margin-cost');
const {
  buildMarginReportWorkbook,
  buildMarginReportPdfHtml,
} = require('../lib/margin-report-exports');
const {
  dateStamp,
  ensureExtension,
} = require('./margins');

const PERIODS = Object.freeze({
  today: Object.freeze({
    key: 'today',
    label: 'Today',
    sql: `date(s.datetime)=date('now','localtime')`,
  }),
  yesterday: Object.freeze({
    key: 'yesterday',
    label: 'Yesterday',
    sql: `date(s.datetime)=date('now','localtime','-1 day')`,
  }),
  week: Object.freeze({
    key: 'week',
    label: 'This Week',
    sql: `date(s.datetime) >= date('now','localtime','-' || ((CAST(strftime('%w','now','localtime') AS INTEGER) + 6) % 7) || ' days')
          AND date(s.datetime) <= date('now','localtime')`,
  }),
  month: Object.freeze({
    key: 'month',
    label: 'This Month',
    sql: `strftime('%Y-%m',s.datetime)=strftime('%Y-%m','now','localtime')`,
  }),
  year: Object.freeze({
    key: 'year',
    label: 'This Year',
    sql: `strftime('%Y',s.datetime)=strftime('%Y','now','localtime')`,
  }),
});

function normalizePeriod(value) {
  const key = String(value == null ? 'today' : value).trim().toLowerCase();
  const period = PERIODS[key];
  if (!period) {
    throw new Error('Choose Today, Yesterday, This Week, This Month, or This Year');
  }
  return period;
}

function buildSoldReportRow(raw) {
  const qtySold = round2(Number(raw.qty_sold) || 0);
  const costQty = round2(Number(raw.cost_qty) || qtySold);
  const baligya = round2(Number(raw.baligya) || 0);
  const isService = Number(raw.is_service) === 1;
  const hasProduct = raw.product_id != null && Number(raw.has_product) === 1;
  const stock = hasProduct && !isService && Number.isFinite(Number(raw.stock))
    ? Number(raw.stock)
    : null;
  const cost = resolveUnitCost(
    hasProduct ? raw.price : null,
    hasProduct ? raw.margin_original_cost : null
  );
  const puhunan = cost.unit_cost != null
    ? round2(cost.unit_cost * costQty)
    : null;
  const halin = puhunan != null ? round2(baligya - puhunan) : null;

  return {
    product_id: raw.product_id == null ? null : Number(raw.product_id),
    name: String(raw.name || 'Unknown item'),
    unit: String(raw.unit || ''),
    qty_sold: qtySold,
    stock,
    is_service: isService,
    selling_price: cost.selling_price,
    unit_cost: cost.unit_cost,
    unit_profit: cost.unit_profit,
    puhunan,
    baligya,
    halin,
    needs_manual_cost: cost.needs_manual_cost || (!hasProduct && baligya > 0),
    cost_mode: hasProduct ? cost.cost_mode : 'invalid',
  };
}

function generateReport(db, periodKey = 'today') {
  const period = normalizePeriod(periodKey);
  const rawRows = db.prepare(`
    SELECT si.product_id AS product_id,
           COALESCE(MAX(p.name), MAX(si.name)) AS name,
           COALESCE(MAX(p.base_unit), MAX(si.unit), '') AS unit,
           SUM(si.qty) AS qty_sold,
           SUM(
             CASE
               WHEN si.line_type = 'service' OR COALESCE(p.is_service, 0) = 1 THEN si.qty
               WHEN COALESCE(si.stock_consumed, 0) > 0 THEN si.stock_consumed
               ELSE si.qty
             END
           ) AS cost_qty,
           SUM(
             si.amount - CASE
               WHEN COALESCE(s.discount, 0) > 0 AND sale_totals.line_total > 0
                 THEN s.discount * si.amount / sale_totals.line_total
               ELSE 0
             END
           ) AS baligya,
           MAX(p.stock) AS stock,
           MAX(p.price) AS price,
           MAX(p.margin_original_cost) AS margin_original_cost,
           MAX(CASE
             WHEN si.line_type = 'service' THEN 1
             ELSE COALESCE(p.is_service, 0)
           END) AS is_service,
           MAX(CASE WHEN p.id IS NULL THEN 0 ELSE 1 END) AS has_product
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      JOIN (
        SELECT sale_id, SUM(amount) AS line_total
          FROM sale_items
         GROUP BY sale_id
      ) sale_totals ON sale_totals.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE s.status = 'completed'
       AND ${period.sql}
     GROUP BY si.product_id
     ORDER BY baligya DESC, name COLLATE NOCASE
  `).all();

  const rows = rawRows.map(buildSoldReportRow);
  const totals = rows.reduce((acc, row) => {
    acc.item_count += 1;
    acc.qty_sold += row.qty_sold;
    acc.baligya += row.baligya;
    if (row.puhunan != null) acc.puhunan += row.puhunan;
    if (row.halin != null) acc.halin += row.halin;
    if (row.needs_manual_cost || row.puhunan == null) acc.missing_cost_count += 1;
    return acc;
  }, {
    item_count: 0,
    qty_sold: 0,
    puhunan: 0,
    baligya: 0,
    halin: 0,
    missing_cost_count: 0,
  });

  totals.qty_sold = round2(totals.qty_sold);
  totals.puhunan = round2(totals.puhunan);
  totals.baligya = round2(totals.baligya);
  totals.halin = round2(totals.halin);

  return {
    period: period.key,
    label: period.label,
    generatedAt: new Date().toISOString(),
    rules: MARGIN_RULES.map((rule) => ({ ...rule })),
    rows,
    totals,
  };
}

async function chooseExportPath(ctx, extension, label, periodLabel) {
  const stamp = dateStamp();
  const safePeriod = String(periodLabel || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'report';
  const result = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
    title: `Save Margin table Reports as ${label}`,
    defaultPath: `yankent-margin-reports-${safePeriod}-${stamp}${extension}`,
    filters: [{ name: label, extensions: [extension.slice(1)] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  return ensureExtension(result.filePath, extension);
}

async function writePdf(ctx, filePath, report) {
  const tempPath = path.join(
    os.tmpdir(),
    `yankent-margin-reports-${randomUUID()}.html`
  );
  let printWindow = null;
  try {
    await fs.promises.writeFile(tempPath, buildMarginReportPdfHtml(report), 'utf8');
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

  guard(ipcMain, 'pos:marginReports:generate', { admin: true }, (_c, period) => (
    generateReport(db, period)
  ));

  guard(ipcMain, 'pos:marginReports:exportExcel', { admin: true }, async (_c, period) => {
    const report = generateReport(db, period);
    const filePath = await chooseExportPath(ctx, '.xlsx', 'Excel Workbook', report.label);
    if (!filePath) return { canceled: true };
    const buffer = await buildMarginReportWorkbook(report);
    await fs.promises.writeFile(filePath, buffer);
    return { canceled: false, filePath };
  });

  guard(ipcMain, 'pos:marginReports:exportPdf', { admin: true }, async (_c, period) => {
    const report = generateReport(db, period);
    const filePath = await chooseExportPath(ctx, '.pdf', 'PDF Document', report.label);
    if (!filePath) return { canceled: true };
    await writePdf(ctx, filePath, report);
    return { canceled: false, filePath };
  });
}

module.exports = {
  register,
  generateReport,
  normalizePeriod,
  PERIODS,
  buildSoldReportRow,
};
