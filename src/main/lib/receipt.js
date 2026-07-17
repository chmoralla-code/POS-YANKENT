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

  // Sanitize the currency symbol for the printer: the peso sign (U+20B1)
  // is 1 char in JS but expands to "PHP " (4 chars) when the ESC/POS
  // encoder emits it (and renders as a blank box on Windows drivers that
  // don't support it).  Expanding here makes formatMoney's output length
  // match what the printer actually renders, so padLine's width math is
  // exact and lines don't overflow/wrap.
  const rawSymbol = db.prepare("SELECT value FROM settings WHERE key='currency_symbol'").get()?.value || 'PHP';
  const symbol = String(rawSymbol).replace(/\u20b1/g, 'PHP ');
  const s = (k, d) => {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
    return r ? r.value : d;
  };
  const configuredVatRate = Number(s('vat_rate', '12')) || 0;
  // Use the rate embodied in this sale's stored VAT split. Reprints must not
  // relabel historical receipts if the store changes its configured rate.
  const storedVatRate = Number(sale.subtotal) > 0
    ? Number(((Number(sale.vat) / Number(sale.subtotal)) * 100).toFixed(2))
    : configuredVatRate;

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
    vatRate: Number.isFinite(storedVatRate) ? storedVatRate : configuredVatRate,
  };
}

/**
 * Pad/center helpers for plain-text receipt (used by the printable HTML fallback
 * and as a readable preview).
 */
function fmtLine(receipt, name, qty, unit, unitPrice, amount, width) {
  const sym = receipt.symbol;
  const left = `${formatQty(qty)} ${unit} ${truncate(name, Math.max(8, width - 22))}`;
  const right = formatMoney(amount, sym);
  return padLine(left, right, width);
}

function formatQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function truncate(s, n) {
  s = String(s);
  n = Math.max(0, Math.floor(n));
  if (s.length <= n) return s;
  // Use ASCII "..." (3 chars) rather than Unicode ellipsis U+2026 (1 char).
  // The ESC/POS encoder expands U+2026 to "..." when writing to the
  // thermal printer, and Windows print drivers render U+2026 as a blank
  // box — so a 1-char ellipsis in JS becomes 3 chars (or an unprintable
  // glyph) at the printer.  Emitting ASCII "..." directly keeps the JS
  // string length equal to the rendered width, so padLine/row math holds.
  if (n <= 3) return s.slice(0, n);
  return s.slice(0, n - 3) + '...';
}

function padLine(left, right, width) {
  left = String(left);
  right = String(right);
  // Safety net: if left + right can't fit on one line with at least one
  // space between them, shrink left (truncating with "..." so the cut is
  // visible) so right stays intact on the same line.  This catches any
  // residual expansion from user-supplied text (store name, customer,
  // project) that still contains wide characters after upstream
  // sanitization.
  if (left.length + right.length >= width) {
    const maxLeft = Math.max(0, width - right.length - 1);
    if (maxLeft < left.length) {
      left = maxLeft <= 3 ? left.slice(0, maxLeft) : left.slice(0, maxLeft - 3) + '...';
    }
  }
  const space = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function wrapLine(text, width) {
  // Word-wrap a long string into lines of at most `width` chars.
  // Used for user-supplied free text (store name, address, footer) that
  // can exceed the paper width — centerLine would otherwise emit a single
  // line longer than the paper and the printer would wrap it mid-word.
  text = String(text);
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!w) continue;
    if (cur.length === 0) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  // Guard against a single word longer than width (hard-split it).
  return lines.flatMap((l) =>
    l.length <= width ? [l] : Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width))
  );
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
  // Leading blank line gives the printer paper a little feed before the
  // store name prints — one line is enough; more wastes paper.
  lines.push('');
  for (const l of wrapLine(receipt.storeName, width)) lines.push(centerLine(l, width));
  if (receipt.address) for (const l of wrapLine(receipt.address, width)) lines.push(centerLine(l, width));
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
  if (receipt.vatRate > 0) lines.push(padLine(`VAT ${receipt.vatRate}% incl.`, formatMoney(receipt.vat, sym), width));
  lines.push(padLine('TOTAL', formatMoney(receipt.total, sym), width));
  if (receipt.paymentMethod === 'cash') {
    lines.push(padLine('Cash', formatMoney(receipt.tendered, sym), width));
    lines.push(padLine('Change', formatMoney(receipt.change, sym), width));
  }
  lines.push(sep);
  for (const l of String(receipt.footer).split('\n')) {
    for (const wl of wrapLine(l, width)) lines.push(centerLine(wl, width));
  }
  // Trailing blank lines so the footer text clears the cutter — without
  // this the last line is still inside the printer and hard to tear off.
  // 4 lines ≈ enough paper feed for the auto-cutter to push the footer
  // past the tear bar on POS-58 printers without wasting paper.
  lines.push('');
  lines.push('');
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildReceipt, receiptPlainText, formatQty, formatMoney };
