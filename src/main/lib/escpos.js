'use strict';

/**
 * Minimal ESC/POS command builder for thermal printers (Bluetooth or serial).
 * Produces a Buffer of bytes. Tested in plain Node.
 *
 * Commands used:
 *   ESC @          init
 *   ESC a n        align (0 left,1 center,2 right)
 *   ESC E n        bold (1 on,0 off)
 *   GS ! n         text size (n=0x11 = double w+h)
 *   ESC d n        feed n lines
 *   GS V 0         partial cut
 */

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Sanitize a string for a thermal printer's CP437/latin1 code page.
 * The peso sign (U+20B1), smart quotes, ellipsis, and en/em dashes all
 * expand to multi-char ASCII sequences — so this function is also the
 * canonical "what will actually be rendered" view used by row() to
 * compute column widths before bytes are emitted.
 */
function sanitizeText(s) {
  return String(s)
    .replace(/\u20b1/g, 'PHP ')            // peso sign -> "PHP "
    .replace(/[\u2018\u2019]/g, "'")        // smart single quotes
    .replace(/[\u201c\u201d]/g, '"')        // smart double quotes
    .replace(/\u2026/g, '...')              // unicode ellipsis
    .replace(/[\u2013\u2014]/g, '-')       // en/em dash
    .replace(/[^\x00-\xff]/g, '');          // strip any other non-latin1 chars
}

/**
 * Word-wrap a string to at most `width` chars per line.
 * Sanitizes first so the wrap point is based on rendered width, not the
 * raw JS length (a peso sign counts as 4 chars once expanded to "PHP ").
 */
function wrapText(s, width) {
  const text = sanitizeText(s);
  if (text.length <= width) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
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
  return lines.flatMap((l) =>
    l.length <= width ? [l] : Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width))
  );
}

class Escpos {
  constructor(width = 32) {
    this.width = width;
    this.chunks = [];
    this.init();
  }
  _push(...bytes) { this.chunks.push(Buffer.from(bytes)); }
  _text(s) {
    // Sanitize through the shared helper so the bytes written to the
    // printer match what row() measured when it computed column spacing.
    this.chunks.push(Buffer.from(sanitizeText(s), 'latin1'));
  }
  init() { this._push(ESC, 0x40); }
  align(n) { this._push(ESC, 0x61, n); }
  bold(on) { this._push(ESC, 0x45, on ? 1 : 0); }
  size(n) { this._push(GS, 0x21, n); }
  feed(n = 1) { this._push(ESC, 0x64, n); }
  cut() { this.feed(2); this._push(GS, 0x56, 0x00); }
  text(s) { this._text(s); }
  line(s = '') { this._text(s + '\n'); }
  center(s) {
    // Word-wrap long centered text so store name/address/footer lines
    // never exceed the paper width.  Each wrapped fragment is centered
    // independently; a single over-long word is hard-split at the width.
    for (const line of wrapText(s, this.width)) {
      const pad = Math.max(0, Math.floor((this.width - line.length) / 2));
      this.align(1);
      this.line(' '.repeat(pad) + line);
      this.align(0);
    }
  }
  right(s) { this.align(2); this.line(s); this.align(0); }
  boldLine(s) { this.bold(1); this.line(s); this.bold(0); }

  /** Two-column row: left label, right value, right-aligned value.
   *  Sanitizes both sides BEFORE measuring so the on-paper width matches
   *  the computed width (the peso sign and ellipsis both expand when
   *  rendered, which previously made lines overflow and wrap mid-number). */
  row(left, right) {
    const w = this.width;
    const l = sanitizeText(left);
    const r = sanitizeText(right);
    if (l.length + r.length < w) {
      const space = w - l.length - r.length;
      this.line(l + ' '.repeat(space) + r);
      return;
    }
    // Doesn't fit as-is — try shrinking left so right stays on this line.
    const maxLeft = Math.max(0, w - r.length - 1);
    if (r.length < w && maxLeft > 0) {
      const lTrim = maxLeft <= 3 ? l.slice(0, maxLeft) : l.slice(0, maxLeft - 3) + '...';
      const space = w - lTrim.length - r.length;
      this.line(lTrim + ' '.repeat(space) + r);
      return;
    }
    // Right alone fills the width — stack the two lines.
    this.line(l);
    this.right(r);
  }

  separator() { this.line('-'.repeat(this.width)); }

  toBuffer() { return Buffer.concat(this.chunks); }
}

/**
 * Encode a receipt object (from lib/receipt) into ESC/POS bytes.
 */
function encodeReceipt(receipt, width = 32) {
  const e = new Escpos(width);
  const sym = receipt.symbol || 'PHP';
  const { formatMoney } = require('./money');

  // Leading paper feed so the store name isn't printed right at the paper
  // edge — helps when the previous cut left the roll pulled back slightly.
  e.feed(3);
  e.center(receipt.storeName || 'YANKENT POS');
  if (receipt.address) e.center(receipt.address);
  if (receipt.tin) e.center('TIN: ' + receipt.tin);
  if (receipt.phone) e.center(receipt.phone);
  e.feed(1);
  e.separator();
  e.row('Txn:', receipt.txnId);
  e.row('Date:', receipt.datetime);
  e.row('Cashier:', receipt.cashier);
  e.row('Customer:', truncate(receipt.customer, width - 10));
  if (receipt.project) e.row('Project:', truncate(receipt.project, width - 9));
  if (receipt.poNumber) e.row('PO:', receipt.poNumber);
  e.row('Pay:', receipt.paymentMethod.toUpperCase() + (receipt.reference ? ' ' + receipt.reference : ''));
  e.separator();

  for (const i of receipt.items) {
    e.row(`${fmtQty(i.qty)} ${i.unit} ${truncate(i.name, Math.max(6, width - 22))}`, formatMoney(i.amount, sym));
  }
  if (receipt.deliveryFee) e.row('Delivery', formatMoney(receipt.deliveryFee, sym));
  if (receipt.discount) e.row('Discount', '-' + formatMoney(receipt.discount, sym));
  e.separator();
  e.row('Subtotal', formatMoney(receipt.subtotal, sym));
  if (receipt.vatRate > 0) e.row(`VAT ${receipt.vatRate}%`, '+' + formatMoney(receipt.vat, sym));
  e.boldLine('');
  e.row('TOTAL', formatMoney(receipt.total, sym));
  e.bold(0);
  if (receipt.paymentMethod === 'cash') {
    e.row('Cash', formatMoney(receipt.tendered, sym));
    e.row('Change', formatMoney(receipt.change, sym));
  }
  e.separator();
  // Footer lines are centered — center() now word-wraps long lines so
  // they stay within the paper width instead of overflowing mid-word.
  for (const l of String(receipt.footer).split('\n')) e.center(l);
  // Feed enough paper so the footer text clears the cutter — POS-58
  // mechanisms need ~8 lines of feed past the print head before the
  // auto-cutter can sever the paper cleanly.
  e.feed(8);
  e.cut();
  return e.toBuffer();
}

/** A short test-print buffer. */
function testPrint(width = 32) {
  const e = new Escpos(width);
  e.init();
  e.center('YANKENT POS');
  e.center('Printer Test');
  e.separator();
  e.row('Status:', 'Connected OK');
  e.row('Width:', String(width) + ' chars');
  e.row('Time:', new Date().toLocaleString());
  e.separator();
  e.center('abcdefghijklmnopqrstuvwxyz');
  e.center('0123456789 .,:%-/+');
  e.feed(2);
  e.cut();
  return e.toBuffer();
}

function truncate(s, n) {
  s = String(s);
  n = Math.max(0, Math.floor(n));
  if (s.length <= n) return s;
  // ASCII "..." (not U+2026) so the JS length matches the rendered width
  // once sanitizeText runs — prevents row() from under-counting and
  // emitting lines that overflow the paper.
  if (n <= 3) return s.slice(0, n);
  return s.slice(0, n - 3) + '...';
}
function fmtQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(n);
}

module.exports = { Escpos, encodeReceipt, testPrint };
