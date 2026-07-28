'use strict';

const ExcelJS = require('exceljs');

const TABLE_HEADERS = Object.freeze([
  'Item Name',
  'Stock',
  'Place Where Bought',
  'Puhunan (Cost)',
  'Baligya (Sales)',
  'Halin (Gross Profit)',
]);
const TABLE_COL_COUNT = TABLE_HEADERS.length;

const PHP_NUMBER_FORMAT = '"₱"#,##0.00;-"₱"#,##0.00';
const QUANTITY_NUMBER_FORMAT = '#,##0.##';

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

const moneyFormatter = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const quantityFormatter = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const generatedAtFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

function optionalBound(value, label) {
  if (value == null || value === '') return null;
  return finiteNumber(value, label);
}

function textValue(value) {
  return value == null ? '' : String(value);
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseGeneratedAt(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPhp(value) {
  return `₱${moneyFormatter.format(finiteNumber(value, 'Amount'))}`;
}

function formatPhpOrBlank(value) {
  if (value == null || value === '') return '';
  return formatPhp(value);
}

function formatQuantity(value) {
  return quantityFormatter.format(finiteNumber(value, 'Quantity'));
}

function formatGeneratedAt(value) {
  const date = value instanceof Date ? value : parseGeneratedAt(value);
  return date ? `${generatedAtFormatter.format(date)} (Asia/Manila)` : 'Not available';
}

function describeMarginRule(rule) {
  const min = optionalBound(
    rule && rule.min_exclusive !== undefined ? rule.min_exclusive : rule && rule.minExclusive,
    'Margin rule minimum'
  );
  const max = optionalBound(
    rule && rule.max_inclusive !== undefined ? rule.max_inclusive : rule && rule.maxInclusive,
    'Margin rule maximum'
  );

  if (min == null && max == null) return 'All selling prices';
  if (min == null) return `${formatPhp(max)} and below`;
  if (max == null) return `Above ${formatPhp(min)}`;
  return `Above ${formatPhp(min)} through ${formatPhp(max)}`;
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== 'object') {
    throw new TypeError(`Margin rule ${index + 1} must be an object`);
  }
  const minRaw = rule.min_exclusive !== undefined ? rule.min_exclusive : rule.minExclusive;
  const maxRaw = rule.max_inclusive !== undefined ? rule.max_inclusive : rule.maxInclusive;
  const profitRaw = rule.unit_profit !== undefined ? rule.unit_profit : rule.unitProfit;
  return {
    min_exclusive: optionalBound(minRaw, `Margin rule ${index + 1} minimum`),
    max_inclusive: optionalBound(maxRaw, `Margin rule ${index + 1} maximum`),
    unit_profit: finiteNumber(profitRaw, `Margin rule ${index + 1} unit profit`),
  };
}

function rowField(row, snakeCase, camelCase) {
  return row[snakeCase] !== undefined ? row[snakeCase] : row[camelCase];
}

function optionalMoney(value, label) {
  if (value == null || value === '') return null;
  return finiteNumber(value, label);
}

function normalizeRow(row, index) {
  if (!row || typeof row !== 'object') {
    throw new TypeError(`Margin row ${index + 1} must be an object`);
  }
  const prefix = `Margin row ${index + 1}`;
  return {
    name: textValue(row.name),
    unit: textValue(row.unit),
    stock: finiteNumber(row.stock, `${prefix} stock`),
    purchase_source: textValue(rowField(row, 'purchase_source', 'purchaseSource')),
    computed_cost: optionalMoney(
      rowField(row, 'computed_cost', 'computedCost'),
      `${prefix} computed cost`
    ),
    selling_price: finiteNumber(
      rowField(row, 'selling_price', 'sellingPrice'),
      `${prefix} selling price`
    ),
    unit_profit: optionalMoney(
      rowField(row, 'unit_profit', 'unitProfit'),
      `${prefix} unit profit`
    ),
    potential_gross_profit: optionalMoney(
      rowField(row, 'potential_gross_profit', 'potentialGrossProfit'),
      `${prefix} potential gross profit`
    ),
    needs_manual_cost: !!(row.needs_manual_cost || row.needsManualCost),
  };
}

function summaryValue(summary, snakeCase, camelCase, fallback) {
  const value = summary && summary[snakeCase] !== undefined
    ? summary[snakeCase]
    : summary && summary[camelCase] !== undefined
      ? summary[camelCase]
      : fallback;
  return finiteNumber(value, `Summary ${snakeCase}`);
}

function normalizeReport(report) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('Margin report must be an object');
  }
  if (!Array.isArray(report.rows)) {
    throw new TypeError('Margin report rows must be an array');
  }

  const rows = report.rows.map(normalizeRow);
  const rules = Array.isArray(report.rules) ? report.rules.map(normalizeRule) : [];
  const fallback = rows.reduce((totals, row) => {
    totals.total_stock += row.stock;
    totals.retail_value += round2(row.stock * row.selling_price);
    if (row.computed_cost != null) {
      totals.computed_cost += round2(row.stock * row.computed_cost);
    }
    if (row.potential_gross_profit != null) {
      totals.potential_gross_profit += row.potential_gross_profit;
    }
    return totals;
  }, {
    total_stock: 0,
    retail_value: 0,
    computed_cost: 0,
    potential_gross_profit: 0,
  });

  return {
    category: textValue(report.category || 'Newly Added Items'),
    generatedAt: parseGeneratedAt(report.generatedAt),
    rules,
    summary: {
      item_count: summaryValue(report.summary, 'item_count', 'itemCount', rows.length),
      total_stock: summaryValue(
        report.summary,
        'total_stock',
        'totalStock',
        round2(fallback.total_stock)
      ),
      retail_value: summaryValue(
        report.summary,
        'retail_value',
        'retailValue',
        round2(fallback.retail_value)
      ),
      computed_cost: summaryValue(
        report.summary,
        'computed_cost',
        'computedCost',
        round2(fallback.computed_cost)
      ),
      potential_gross_profit: summaryValue(
        report.summary,
        'potential_gross_profit',
        'potentialGrossProfit',
        round2(fallback.potential_gross_profit)
      ),
    },
    rows,
  };
}

function solidFill(color) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
}

function thinBorder(color = COLORS.line) {
  return {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  };
}

function styleRange(worksheet, row, fromColumn, toColumn, style) {
  for (let column = fromColumn; column <= toColumn; column += 1) {
    const cell = worksheet.getCell(row, column);
    if (style.fill) cell.fill = style.fill;
    if (style.font) cell.font = style.font;
    if (style.alignment) cell.alignment = style.alignment;
    if (style.border) cell.border = style.border;
  }
}

function setMetadataRow(worksheet, report) {
  worksheet.getCell('A3').value = 'CATEGORY';
  worksheet.mergeCells('B3:C3');
  worksheet.getCell('B3').value = report.category;
  worksheet.getCell('D3').value = 'GENERATED';
  worksheet.mergeCells('E3:F3');
  // Excel date serials have no timezone. Write the explicit Manila-local
  // display text so a UTC ISO timestamp cannot appear eight hours early.
  worksheet.getCell('E3').value = formatGeneratedAt(report.generatedAt);

  for (const labelAddress of ['A3', 'D3']) {
    const label = worksheet.getCell(labelAddress);
    label.fill = solidFill(COLORS.panel);
    label.font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.ink } };
    label.alignment = { vertical: 'middle', horizontal: 'left' };
    label.border = thinBorder();
  }
  for (const valueAddress of ['B3', 'E3']) {
    const value = worksheet.getCell(valueAddress);
    value.font = { name: 'Arial', size: 9, color: { argb: COLORS.ink } };
    value.alignment = { vertical: 'middle', horizontal: 'left' };
    value.border = thinBorder();
  }
}

function setRulesAndSummary(worksheet, report, firstDetailRow, detailRowCount) {
  const sectionHeaderRow = firstDetailRow - 1;
  worksheet.mergeCells(sectionHeaderRow, 1, sectionHeaderRow, 3);
  worksheet.getCell(sectionHeaderRow, 1).value = 'MARGIN RULES';
  worksheet.mergeCells(sectionHeaderRow, 4, sectionHeaderRow, TABLE_COL_COUNT);
  worksheet.getCell(sectionHeaderRow, 4).value = 'SUMMARY';
  styleRange(worksheet, sectionHeaderRow, 1, TABLE_COL_COUNT, {
    fill: solidFill(COLORS.graphite),
    font: { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.paper } },
    alignment: { vertical: 'middle', horizontal: 'left' },
    border: thinBorder(COLORS.graphite),
  });
  worksheet.getRow(sectionHeaderRow).height = 22;

  for (let offset = 0; offset < detailRowCount; offset += 1) {
    const rowNumber = firstDetailRow + offset;
    worksheet.getRow(rowNumber).height = 22;
    styleRange(worksheet, rowNumber, 1, TABLE_COL_COUNT, {
      fill: solidFill(offset % 2 ? COLORS.softPanel : COLORS.panel),
      font: { name: 'Arial', size: 9, color: { argb: COLORS.ink } },
      alignment: { vertical: 'middle', horizontal: 'left' },
      border: thinBorder(COLORS.softLine),
    });
  }

  if (report.rules.length) {
    report.rules.forEach((rule, index) => {
      const rowNumber = firstDetailRow + index;
      worksheet.mergeCells(rowNumber, 1, rowNumber, 2);
      worksheet.getCell(rowNumber, 1).value = describeMarginRule(rule);
      worksheet.getCell(rowNumber, 3).value = rule.unit_profit;
      worksheet.getCell(rowNumber, 3).numFmt = PHP_NUMBER_FORMAT;
      worksheet.getCell(rowNumber, 3).font = {
        name: 'Arial',
        size: 9,
        bold: true,
        color: { argb: COLORS.ink },
      };
      worksheet.getCell(rowNumber, 3).alignment = {
        vertical: 'middle',
        horizontal: 'right',
      };
    });
  } else {
    worksheet.mergeCells(firstDetailRow, 1, firstDetailRow, 3);
    worksheet.getCell(firstDetailRow, 1).value = 'No margin rules supplied';
    worksheet.getCell(firstDetailRow, 1).font = {
      name: 'Arial',
      size: 9,
      italic: true,
      color: { argb: COLORS.muted },
    };
  }

  const summary = report.summary;
  const summaryRows = [
    { label: 'Total Puhunan (Cost)', value: summary.computed_cost, format: PHP_NUMBER_FORMAT },
    { label: 'Total Baligya (Sales)', value: summary.retail_value, format: PHP_NUMBER_FORMAT },
    { label: 'Total Halin (Gross Profit)', value: summary.potential_gross_profit, format: PHP_NUMBER_FORMAT },
  ];

  summaryRows.forEach((entry, rowOffset) => {
    const rowNumber = firstDetailRow + rowOffset;
    worksheet.mergeCells(rowNumber, 4, rowNumber, 5);
    worksheet.getCell(rowNumber, 4).value = entry.label;
    worksheet.getCell(rowNumber, 4).font = {
      name: 'Arial',
      size: 8,
      bold: true,
      color: { argb: COLORS.muted },
    };
    worksheet.getCell(rowNumber, 6).value = entry.value;
    worksheet.getCell(rowNumber, 6).numFmt = entry.format;
    worksheet.getCell(rowNumber, 6).font = {
      name: 'Arial',
      size: rowOffset === 2 ? 11 : 10,
      bold: true,
      color: { argb: COLORS.ink },
    };
    worksheet.getCell(rowNumber, 6).alignment = {
      vertical: 'middle',
      horizontal: 'right',
    };
  });
}

function setTableStyles(worksheet, tableHeaderRow, dataRowCount) {
  const headerRow = worksheet.getRow(tableHeaderRow);
  headerRow.height = 28;
  for (let column = 1; column <= TABLE_COL_COUNT; column += 1) {
    const cell = headerRow.getCell(column);
    cell.fill = solidFill(COLORS.ink);
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: COLORS.paper } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder(COLORS.ink);
  }

  for (let offset = 1; offset <= dataRowCount; offset += 1) {
    const row = worksheet.getRow(tableHeaderRow + offset);
    row.height = 22;
    for (let column = 1; column <= TABLE_COL_COUNT; column += 1) {
      const cell = row.getCell(column);
      cell.fill = solidFill(offset % 2 === 0 ? COLORS.softPanel : COLORS.paper);
      cell.font = { name: 'Arial', size: 9, color: { argb: COLORS.ink } };
      cell.border = {
        bottom: { style: 'thin', color: { argb: COLORS.softLine } },
      };
      if (column === 2 || column >= 4) {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      }
    }
    row.getCell(2).numFmt = QUANTITY_NUMBER_FORMAT;
    for (const column of [4, 5, 6]) {
      row.getCell(column).numFmt = PHP_NUMBER_FORMAT;
    }
  }
}

function writeDataTable(worksheet, tableHeaderRow, tableRows) {
  TABLE_HEADERS.forEach((header, index) => {
    worksheet.getCell(tableHeaderRow, index + 1).value = header;
  });

  tableRows.forEach((values, rowIndex) => {
    const excelRow = tableHeaderRow + 1 + rowIndex;
    values.forEach((value, columnIndex) => {
      worksheet.getCell(excelRow, columnIndex + 1).value = value == null ? null : value;
    });
  });

  const lastDataRow = tableHeaderRow + Math.max(tableRows.length, 1);
  worksheet.autoFilter = {
    from: { row: tableHeaderRow, column: 1 },
    to: { row: lastDataRow, column: TABLE_COL_COUNT },
  };
}

async function buildMarginWorkbook(reportInput) {
  const report = normalizeReport(reportInput);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'YANKENT POS';
  workbook.lastModifiedBy = 'YANKENT POS';
  workbook.title = 'Product Margin Table';
  workbook.subject = `Margin table for ${report.category}`;
  workbook.description = 'Computed inventory cost and potential gross profit report';
  workbook.keywords = 'YANKENT POS, inventory, margin, gross profit';
  workbook.company = 'YANKENT';
  if (report.generatedAt) {
    workbook.created = new Date(report.generatedAt.getTime());
    workbook.modified = new Date(report.generatedAt.getTime());
  }

  const worksheet = workbook.addWorksheet('Product Margin Table', {
    properties: {
      defaultRowHeight: 18,
      pageSetUpPr: { fitToPage: true },
    },
  });
  worksheet.views = [{ state: 'normal', showGridLines: false }];
  [36, 10, 22, 14, 14, 14].forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });

  worksheet.mergeCells(1, 1, 1, TABLE_COL_COUNT);
  worksheet.getCell('A1').value = 'YANKENT POS';
  styleRange(worksheet, 1, 1, TABLE_COL_COUNT, {
    fill: solidFill(COLORS.ink),
    font: { name: 'Arial', size: 11, bold: true, color: { argb: COLORS.paper } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  });
  worksheet.getRow(1).height = 24;

  worksheet.mergeCells(2, 1, 2, TABLE_COL_COUNT);
  worksheet.getCell('A2').value = 'PRODUCT MARGIN TABLE';
  styleRange(worksheet, 2, 1, TABLE_COL_COUNT, {
    fill: solidFill(COLORS.ink),
    font: { name: 'Arial', size: 20, bold: true, color: { argb: COLORS.paper } },
    alignment: { vertical: 'middle', horizontal: 'left' },
    border: {
      bottom: { style: 'medium', color: { argb: COLORS.graphite } },
    },
  });
  worksheet.getRow(2).height = 32;
  setMetadataRow(worksheet, report);
  worksheet.getRow(3).height = 22;
  worksheet.getRow(4).height = 8;

  const firstDetailRow = 6;
  const detailRowCount = Math.max(report.rules.length, 3);
  setRulesAndSummary(worksheet, report, firstDetailRow, detailRowCount);

  const noteRow = firstDetailRow + detailRowCount + 1;
  worksheet.mergeCells(noteRow, 1, noteRow, TABLE_COL_COUNT);
  worksheet.getCell(noteRow, 1).value =
    'Puhunan (Cost) = Baligya (Sales) - Profit Margin | Halin (Gross Profit) = Stock x Unit Profit';
  worksheet.getCell(noteRow, 1).font = {
    name: 'Arial',
    size: 9,
    italic: true,
    color: { argb: COLORS.muted },
  };
  worksheet.getCell(noteRow, 1).alignment = {
    vertical: 'middle',
    horizontal: 'left',
    wrapText: true,
  };
  worksheet.getCell(noteRow, 1).fill = solidFill(COLORS.softPanel);
  worksheet.getCell(noteRow, 1).border = thinBorder(COLORS.softLine);
  worksheet.getRow(noteRow).height = 22;

  const tableHeaderRow = noteRow + 1;
  const tableRows = report.rows.map((row) => [
    row.name,
    row.stock,
    row.purchase_source,
    row.computed_cost,
    row.selling_price,
    row.potential_gross_profit,
  ]);

  writeDataTable(worksheet, tableHeaderRow, tableRows);
  setTableStyles(worksheet, tableHeaderRow, tableRows.length);

  worksheet.views = [{
    state: 'frozen',
    ySplit: tableHeaderRow,
    topLeftCell: `A${tableHeaderRow + 1}`,
    activeCell: `A${tableHeaderRow + 1}`,
    showGridLines: false,
  }];

  const finalRow = tableHeaderRow + Math.max(tableRows.length, 1);
  worksheet.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: {
      left: 0.3,
      right: 0.3,
      top: 0.45,
      bottom: 0.45,
      header: 0.2,
      footer: 0.2,
    },
    printArea: `A1:F${finalRow}`,
    printTitlesRow: `${tableHeaderRow}:${tableHeaderRow}`,
  };
  worksheet.headerFooter.oddHeader = '&LYANKENT POS&CProduct Margin Table&R&D';
  worksheet.headerFooter.oddFooter = '&LGenerated by YANKENT POS&CConfidential&RPage &P of &N';

  const result = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

function escapeHtml(value) {
  return textValue(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function buildMarginPdfHtml(reportInput) {
  const report = normalizeReport(reportInput);
  const generatedAt = formatGeneratedAt(report.generatedAt);
  const generatedAtIso = report.generatedAt ? report.generatedAt.toISOString() : '';
  const rules = report.rules.length
    ? report.rules.map((rule) => `
          <div class="rule">
            <span>${escapeHtml(describeMarginRule(rule))}</span>
            <strong>${escapeHtml(formatPhp(rule.unit_profit))} profit</strong>
          </div>`).join('')
    : '<div class="rule rule-empty">No margin rules supplied</div>';
  const rows = report.rows.length
    ? report.rows.map((row) => `
          <tr>
            <td class="item">${escapeHtml(row.name)}</td>
            <td class="number">${escapeHtml(formatQuantity(row.stock))}</td>
            <td>${escapeHtml(row.purchase_source)}</td>
            <td class="money">${escapeHtml(formatPhpOrBlank(row.computed_cost))}</td>
            <td class="money">${escapeHtml(formatPhp(row.selling_price))}</td>
            <td class="money strong">${escapeHtml(formatPhpOrBlank(row.potential_gross_profit))}</td>
          </tr>`).join('')
    : '<tr class="empty"><td colspan="6">No eligible products were included.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YANKENT POS - Product Margin Table</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 11mm 10mm 12mm;
    }
    * {
      box-sizing: border-box;
    }
    html {
      color: #171717;
      background: #fff;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 10px;
      line-height: 1.35;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      margin: 0;
      background: #fff;
    }
    .report-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      padding: 0 0 10px;
      border-bottom: 3px solid #171717;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .brand {
      margin: 0 0 3px;
      color: #5b5b5b;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 25px;
      line-height: 1.05;
      letter-spacing: -0.02em;
    }
    .meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 10px;
      min-width: 310px;
      margin: 0;
      font-size: 9px;
    }
    .meta dt {
      margin: 0;
      color: #6b6b6b;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .meta dd {
      margin: 0;
      font-weight: 600;
      text-align: right;
    }
    .overview {
      display: grid;
      grid-template-columns: minmax(310px, 0.9fr) minmax(520px, 1.6fr);
      gap: 10px;
      margin: 10px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .panel {
      border: 1px solid #cfcfcf;
      background: #f7f7f7;
    }
    .panel-title {
      margin: 0;
      padding: 6px 9px;
      background: #343434;
      color: #fff;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .rules {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      background: #d8d8d8;
    }
    .rule {
      display: flex;
      min-height: 48px;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 7px 9px;
      background: #fff;
    }
    .rule span {
      color: #666;
      font-size: 8.5px;
    }
    .rule strong {
      font-size: 10px;
    }
    .rule-empty {
      grid-column: 1 / -1;
      color: #666;
      font-style: italic;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 1px;
      background: #d8d8d8;
    }
    .kpi {
      min-height: 48px;
      padding: 7px 9px;
      background: #fff;
    }
    .kpi-label {
      display: block;
      min-height: 20px;
      color: #666;
      font-size: 7.7px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .kpi-value {
      display: block;
      margin-top: 2px;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .formula-note {
      margin: 0 0 8px;
      padding: 5px 8px;
      border-left: 3px solid #353535;
      background: #f2f2f2;
      color: #555;
      font-size: 8.5px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 8.4px;
    }
    col.item-col { width: 28%; }
    col.stock-col { width: 10%; }
    col.source-col { width: 22%; }
    col.cost-col { width: 13%; }
    col.price-col { width: 13%; }
    col.gross-col { width: 14%; }
    thead {
      display: table-header-group;
    }
    thead th {
      padding: 7px 6px;
      border: 1px solid #171717;
      background: #171717;
      color: #fff;
      font-size: 7.8px;
      font-weight: 800;
      line-height: 1.2;
      text-align: left;
      text-transform: uppercase;
      vertical-align: middle;
    }
    thead th.number,
    thead th.money {
      text-align: right;
    }
    tbody tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    tbody tr:nth-child(even) {
      background: #f6f6f6;
    }
    td {
      padding: 6px;
      border-bottom: 1px solid #dedede;
      overflow-wrap: anywhere;
      vertical-align: top;
    }
    td.item {
      font-weight: 650;
    }
    td.unit {
      text-align: center;
    }
    td.number,
    td.money {
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
    }
    td.strong {
      font-weight: 800;
    }
    tr.empty td {
      padding: 18px;
      color: #666;
      font-style: italic;
      text-align: center;
    }
    .report-footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: 8px;
      padding-top: 5px;
      border-top: 1px solid #bdbdbd;
      color: #666;
      font-size: 7.8px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    @media print {
      body {
        width: auto;
      }
      .report-header,
      .overview,
      .formula-note {
        break-after: avoid;
        page-break-after: avoid;
      }
    }
  </style>
</head>
<body>
  <header class="report-header">
    <div>
      <p class="brand">YANKENT POS</p>
      <h1>Product Margin Table</h1>
    </div>
    <dl class="meta">
      <dt>Category</dt>
      <dd>${escapeHtml(report.category)}</dd>
      <dt>Generated</dt>
      <dd><time datetime="${escapeHtml(generatedAtIso)}">${escapeHtml(generatedAt)}</time></dd>
    </dl>
  </header>

  <section class="overview" aria-label="Margin rules and inventory summary">
    <div class="panel">
      <h2 class="panel-title">Margin Rules</h2>
      <div class="rules">${rules}
      </div>
    </div>
    <div class="panel">
      <h2 class="panel-title">Summary</h2>
      <div class="kpis">
        <div class="kpi">
          <span class="kpi-label">Total Puhunan (Cost)</span>
          <span class="kpi-value">${escapeHtml(formatPhp(report.summary.computed_cost))}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total Baligya (Sales)</span>
          <span class="kpi-value">${escapeHtml(formatPhp(report.summary.retail_value))}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Total Halin (Gross Profit)</span>
          <span class="kpi-value">${escapeHtml(formatPhp(report.summary.potential_gross_profit))}</span>
        </div>
      </div>
    </div>
  </section>

  <p class="formula-note">
    Puhunan (Cost) = Baligya (Sales) − Profit Margin | Halin (Gross Profit) = Stock × Unit Profit
  </p>

  <table aria-label="Product margin table">
    <colgroup>
      <col class="item-col">
      <col class="stock-col">
      <col class="source-col">
      <col class="cost-col">
      <col class="price-col">
      <col class="gross-col">
    </colgroup>
    <thead>
      <tr>
        <th>Item Name</th>
        <th class="number">Stock</th>
        <th>Place Where Bought</th>
        <th class="money">Puhunan (Cost)</th>
        <th class="money">Baligya (Sales)</th>
        <th class="money">Halin (Gross Profit)</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <footer class="report-footer">
    <span>YANKENT POS | Product Margin Table</span>
    <span>Generated ${escapeHtml(generatedAt)}</span>
  </footer>
</body>
</html>`;
}

module.exports = {
  buildMarginWorkbook,
  buildMarginPdfHtml,
  normalizeReport,
  describeMarginRule,
  escapeHtml,
  formatPhp,
  formatQuantity,
  formatGeneratedAt,
  TABLE_HEADERS,
  PHP_NUMBER_FORMAT,
};
