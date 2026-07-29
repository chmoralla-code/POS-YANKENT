'use strict';

/**
 * Excel / PDF builders for Margin table Reports (sold items by period).
 */

const ExcelJS = require('exceljs');
const {
  escapeHtml,
  formatPhp,
  formatQuantity,
  formatGeneratedAt,
  PHP_NUMBER_FORMAT,
} = require('./margin-exports');

const REPORT_HEADERS = Object.freeze([
  'Item Name',
  'Qty Sold',
  'Stock Left',
  'Puhunan (Cost)',
  'Baligya (Sales)',
  'Halin (Gross Profit)',
]);

const COLORS = Object.freeze({
  ink: 'FF171717',
  graphite: 'FF353535',
  muted: 'FF686868',
  line: 'FFD4D4D4',
  softLine: 'FFE5E5E5',
  paper: 'FFFFFFFF',
  panel: 'FFF2F2F2',
  softPanel: 'FFF8F8F8',
});

const QUANTITY_NUMBER_FORMAT = '#,##0.##';

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

function textValue(value) {
  return value == null ? '' : String(value);
}

function formatPhpOrBlank(value) {
  if (value == null || value === '') return '';
  return formatPhp(value);
}

function formatStock(value, isService) {
  if (isService || value == null || value === '') return '—';
  return formatQuantity(value);
}

function normalizeReport(report) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('Margin report must be an object');
  }
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const totals = report.totals && typeof report.totals === 'object'
    ? report.totals
    : {};
  return {
    period: textValue(report.period),
    label: textValue(report.label) || 'Period',
    generatedAt: report.generatedAt,
    separateUtang: !!report.separateUtang,
    rows: rows.map((row, index) => {
      if (!row || typeof row !== 'object') {
        throw new TypeError(`Report row ${index + 1} must be an object`);
      }
      return {
        name: textValue(row.name),
        qty_sold: finiteNumber(row.qty_sold, `Row ${index + 1} qty sold`),
        stock: row.stock == null || row.stock === '' ? null : finiteNumber(row.stock, `Row ${index + 1} stock`),
        is_service: !!row.is_service,
        puhunan: row.puhunan == null || row.puhunan === ''
          ? null
          : finiteNumber(row.puhunan, `Row ${index + 1} puhunan`),
        baligya: finiteNumber(row.baligya, `Row ${index + 1} baligya`),
        halin: row.halin == null || row.halin === ''
          ? null
          : finiteNumber(row.halin, `Row ${index + 1} halin`),
        needs_manual_cost: !!row.needs_manual_cost,
      };
    }),
    totals: {
      item_count: Number(totals.item_count) || rows.length,
      qty_sold: finiteNumber(totals.qty_sold == null ? 0 : totals.qty_sold, 'totals.qty_sold'),
      puhunan: finiteNumber(totals.puhunan == null ? 0 : totals.puhunan, 'totals.puhunan'),
      baligya: finiteNumber(totals.baligya == null ? 0 : totals.baligya, 'totals.baligya'),
      halin: finiteNumber(totals.halin == null ? 0 : totals.halin, 'totals.halin'),
      missing_cost_count: Number(totals.missing_cost_count) || 0,
    },
  };
}

async function buildMarginReportWorkbook(report) {
  const data = normalizeReport(report);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'YANKENT POS';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Margin table Reports', {
    views: [{ state: 'frozen', ySplit: 8 }],
  });

  sheet.columns = [
    { key: 'name', width: 36 },
    { key: 'qty', width: 12 },
    { key: 'stock', width: 12 },
    { key: 'puhunan', width: 16 },
    { key: 'baligya', width: 16 },
    { key: 'halin', width: 18 },
  ];

  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'YANKENT POS';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: COLORS.ink } };

  sheet.mergeCells('A2:F2');
  sheet.getCell('A2').value = 'MARGIN TABLE REPORTS';
  sheet.getCell('A2').font = { bold: true, size: 16, color: { argb: COLORS.ink } };

  sheet.getCell('A3').value = 'Period';
  sheet.getCell('A3').font = { color: { argb: COLORS.muted } };
  sheet.getCell('B3').value = data.label;
  sheet.getCell('B3').font = { bold: true };

  sheet.getCell('A4').value = 'Generated';
  sheet.getCell('A4').font = { color: { argb: COLORS.muted } };
  sheet.getCell('B4').value = formatGeneratedAt(data.generatedAt);

  sheet.getCell('A5').value = 'Items';
  sheet.getCell('A5').font = { color: { argb: COLORS.muted } };
  sheet.getCell('B5').value = data.totals.item_count;

  sheet.getCell('A6').value = 'Scope';
  sheet.getCell('A6').font = { color: { argb: COLORS.muted } };
  sheet.getCell('B6').value = data.separateUtang
    ? 'Paid sales only — Utang excluded'
    : 'All completed sales — Utang included';

  const headerRowIndex = 8;
  REPORT_HEADERS.forEach((header, index) => {
    const cell = sheet.getCell(headerRowIndex, index + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: COLORS.ink } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.panel } };
    cell.border = {
      bottom: { style: 'thin', color: { argb: COLORS.line } },
    };
  });

  data.rows.forEach((row, offset) => {
    const r = headerRowIndex + 1 + offset;
    sheet.getCell(r, 1).value = row.name;
    sheet.getCell(r, 2).value = row.qty_sold;
    sheet.getCell(r, 2).numFmt = QUANTITY_NUMBER_FORMAT;
    if (row.is_service || row.stock == null) {
      sheet.getCell(r, 3).value = '—';
    } else {
      sheet.getCell(r, 3).value = row.stock;
      sheet.getCell(r, 3).numFmt = QUANTITY_NUMBER_FORMAT;
    }
    if (row.puhunan == null) {
      sheet.getCell(r, 4).value = '';
    } else {
      sheet.getCell(r, 4).value = row.puhunan;
      sheet.getCell(r, 4).numFmt = PHP_NUMBER_FORMAT;
    }
    sheet.getCell(r, 5).value = row.baligya;
    sheet.getCell(r, 5).numFmt = PHP_NUMBER_FORMAT;
    if (row.halin == null) {
      sheet.getCell(r, 6).value = '';
    } else {
      sheet.getCell(r, 6).value = row.halin;
      sheet.getCell(r, 6).numFmt = PHP_NUMBER_FORMAT;
    }
    for (let c = 1; c <= 6; c += 1) {
      sheet.getCell(r, c).border = {
        bottom: { style: 'hair', color: { argb: COLORS.softLine } },
      };
    }
  });

  const totalRow = headerRowIndex + 1 + data.rows.length;
  sheet.getCell(totalRow, 1).value = 'TOTAL';
  sheet.getCell(totalRow, 1).font = { bold: true };
  sheet.getCell(totalRow, 2).value = data.totals.qty_sold;
  sheet.getCell(totalRow, 2).numFmt = QUANTITY_NUMBER_FORMAT;
  sheet.getCell(totalRow, 2).font = { bold: true };
  sheet.getCell(totalRow, 4).value = data.totals.puhunan;
  sheet.getCell(totalRow, 4).numFmt = PHP_NUMBER_FORMAT;
  sheet.getCell(totalRow, 4).font = { bold: true };
  sheet.getCell(totalRow, 5).value = data.totals.baligya;
  sheet.getCell(totalRow, 5).numFmt = PHP_NUMBER_FORMAT;
  sheet.getCell(totalRow, 5).font = { bold: true };
  sheet.getCell(totalRow, 6).value = data.totals.halin;
  sheet.getCell(totalRow, 6).numFmt = PHP_NUMBER_FORMAT;
  sheet.getCell(totalRow, 6).font = { bold: true };
  for (let c = 1; c <= 6; c += 1) {
    sheet.getCell(totalRow, c).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.softPanel },
    };
    sheet.getCell(totalRow, c).border = {
      top: { style: 'thin', color: { argb: COLORS.line } },
    };
  }

  if (data.rows.length) {
    sheet.autoFilter = {
      from: { row: headerRowIndex, column: 1 },
      to: { row: headerRowIndex + data.rows.length, column: 6 },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildMarginReportPdfHtml(report) {
  const data = normalizeReport(report);
  const generatedAt = formatGeneratedAt(data.generatedAt);
  const bodyRows = data.rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td class="num">${escapeHtml(formatQuantity(row.qty_sold))}</td>
        <td class="num">${escapeHtml(formatStock(row.stock, row.is_service))}</td>
        <td class="money">${escapeHtml(formatPhpOrBlank(row.puhunan))}</td>
        <td class="money">${escapeHtml(formatPhp(row.baligya))}</td>
        <td class="money">${escapeHtml(formatPhpOrBlank(row.halin))}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>YANKENT POS — Margin table Reports</title>
  <style>
    @page { size: A4 landscape; margin: 14mm; }
    body {
      font-family: "Segoe UI", Arial, sans-serif;
      color: #171717;
      font-size: 11px;
      line-height: 1.35;
    }
    h1 { margin: 0 0 2px; font-size: 18px; letter-spacing: .02em; }
    .eyebrow { margin: 0; color: #686868; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .meta { margin: 10px 0 16px; color: #353535; }
    .meta b { color: #171717; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 8px; border-bottom: 1px solid #e5e5e5; text-align: left; vertical-align: top; }
    th { background: #f2f2f2; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    td.num, th.num, td.money, th.money { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; background: #f8f8f8; border-top: 1px solid #d4d4d4; }
    footer { margin-top: 18px; color: #686868; font-size: 10px; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <p class="eyebrow">YANKENT POS</p>
  <h1>Margin table Reports</h1>
  <p class="meta">
    Period: <b>${escapeHtml(data.label)}</b><br>
    Generated: ${escapeHtml(generatedAt)} · Items: <b>${data.totals.item_count}</b><br>
    Scope: <b>${data.separateUtang ? 'Paid sales only — Utang excluded' : 'All completed sales — Utang included'}</b>
  </p>
  <table>
    <thead>
      <tr>
        <th>Item Name</th>
        <th class="num">Qty Sold</th>
        <th class="num">Stock Left</th>
        <th class="money">Puhunan (Cost)</th>
        <th class="money">Baligya (Sales)</th>
        <th class="money">Halin (Gross Profit)</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `
      <tr><td colspan="6">No sales in this period.</td></tr>`}
    </tbody>
    <tfoot>
      <tr>
        <td>TOTAL</td>
        <td class="num">${escapeHtml(formatQuantity(data.totals.qty_sold))}</td>
        <td class="num"></td>
        <td class="money">${escapeHtml(formatPhp(data.totals.puhunan))}</td>
        <td class="money">${escapeHtml(formatPhp(data.totals.baligya))}</td>
        <td class="money">${escapeHtml(formatPhp(data.totals.halin))}</td>
      </tr>
    </tfoot>
  </table>
  <footer>
    <span>YANKENT POS | Margin table Reports</span>
    <span>Generated ${escapeHtml(generatedAt)}</span>
  </footer>
</body>
</html>`;
}

module.exports = {
  REPORT_HEADERS,
  normalizeReport,
  buildMarginReportWorkbook,
  buildMarginReportPdfHtml,
};
