'use strict';

const { formatMoney } = require('./money');

/**
 * Build a structured receipt object from a persisted sale, for display,
 * ESC/POS encoding, and reprinting.
 * @param {import('../db/shim').Database} db
 * @param {number} saleId
 */
function buildReceipt(db, saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
  if (!sale) return null;

  const items = db.prepare(
    `SELECT name, qty, unit, unit_price, amount, line_type
     FROM sale_items WHERE sale_id=? ORDER BY id`
  ).all(saleId);

  const symbol = db.prepare("SELECT value FROM settings WHERE key='currency_symbol'").get()?.value || 'PHP';
  const s = (k, d) => {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
    return r ? r.value : d;
  };

  return {
    storeName: s('store_name', 'YANKENT POS'),
    address: s('store_address', ''),
    tin: s('store_tin', ''),
    phone: s('store_phone', ''),
    txnId: sale.txn_id,
    datetime: sale.datetime,
    cashier: sale.cashier_name,
    customer: sale.customer_name,
    project: sale.project || '',
    poNumber: sale.po_number || '',
    items: items.map((i) => ({
      name: i.name,
      qty: i.qty,
      unit: i.unit,
      unitPrice: i.unit_price,
      amount: i.amount,
      isService: i.line_type === 'service',
    })),
    subtotal: sale.subtotal,
    vat: sale.vat,
    discount: sale.discount,
    deliveryFee: sale.delivery_fee,
    total: sale.total,
    paymentMethod: sale.payment_method,
    tendered: sale.amount_tendered,
    change: sale.change,
    reference: sale.reference || '',
    footer: s('receipt_footer', 'Thank you!'),
    symbol,
  };
}

/**
 * Pad/center helpers for plain-text receipt (used by the printable HTML fallback
 * and as a readable preview).
 */
function fmtLine(receipt, name, qty, unit, unitPrice, amount, width) {
  const sym = receipt.symbol;
  const left = `${formatQty(qty)} ${unit} ${truncate(name, Math.max(8, width - 24))}`;
  const right = formatMoney(amount, sym);
  return padLine(left, right, width);
}

function formatQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function padLine(left, right, width) {
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function centerLine(text, width) {
  text = String(text);
  if (text.length >= width) return text;
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text;
}

/**
 * Plain-text receipt (monospaced). Used for preview + printable fallback.
 */
function receiptPlainText(receipt, width = 32) {
  const sym = receipt.symbol;
  const lines = [];
  const sep = '-'.repeat(width);
  lines.push(centerLine(receipt.storeName, width));
  if (receipt.address) lines.push(centerLine(receipt.address, width));
  if (receipt.tin) lines.push(centerLine(`TIN: ${receipt.tin}`, width));
  if (receipt.phone) lines.push(centerLine(receipt.phone, width));
  lines.push(sep);
  lines.push(padLine('Txn:', receipt.txnId, width));
  lines.push(padLine('Date:', receipt.datetime, width));
  lines.push(padLine('Cashier:', receipt.cashier, width));
  lines.push(padLine('Customer:', truncate(receipt.customer, width - 10), width));
  if (receipt.project) lines.push(padLine('Project:', truncate(receipt.project, width - 9), width), );
  if (receipt.poNumber) lines.push(padLine('PO:', receipt.poNumber, width));
  lines.push(padLine('Pay:', receipt.paymentMethod.toUpperCase() + (receipt.reference ? ' ' + receipt.reference : ''), width));
  lines.push(sep);
  for (const i of receipt.items) {
    lines.push(fmtLine(receipt, i.name, i.qty, i.unit, i.unitPrice, i.amount, width));
  }
  if (receipt.deliveryFee) lines.push(padLine('Delivery', formatMoney(receipt.deliveryFee, sym), width));
  if (receipt.discount) lines.push(padLine('Discount', '-' + formatMoney(receipt.discount, sym), width));
  lines.push(sep);
  lines.push(padLine('Subtotal', formatMoney(receipt.subtotal, sym), width));
  lines.push(padLine('VAT 12%', formatMoney(receipt.vat, sym), width));
  lines.push(padLine('TOTAL', formatMoney(receipt.total, sym), width));
  if (receipt.paymentMethod === 'cash') {
    lines.push(padLine('Cash', formatMoney(receipt.tendered, sym), width));
    lines.push(padLine('Change', formatMoney(receipt.change, sym), width));
  }
  lines.push(sep);
  for (const l of String(receipt.footer).split('\n')) lines.push(centerLine(l, width));
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildReceipt, receiptPlainText, formatQty, formatMoney };
