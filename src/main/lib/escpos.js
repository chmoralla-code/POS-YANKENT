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

class Escpos {
  constructor(width = 32) {
    this.width = width;
    this.chunks = [];
    this.init();
  }
  _push(...bytes) { this.chunks.push(Buffer.from(bytes)); }
  _text(s) { this.chunks.push(Buffer.from(String(s), 'latin1')); }
  init() { this._push(ESC, 0x40); }
  align(n) { this._push(ESC, 0x61, n); }
  bold(on) { this._push(ESC, 0x45, on ? 1 : 0); }
  size(n) { this._push(GS, 0x21, n); }
  feed(n = 1) { this._push(ESC, 0x64, n); }
  cut() { this.feed(2); this._push(GS, 0x56, 0x00); }
  text(s) { this._text(s); }
  line(s = '') { this._text(s + '\n'); }
  center(s) { this.align(1); this.line(s); this.align(0); }
  right(s) { this.align(2); this.line(s); this.align(0); }
  boldLine(s) { this.bold(1); this.line(s); this.bold(0); }

  /** Two-column row: left label, right value, right-aligned value. */
  row(left, right) {
    const w = this.width;
    const l = String(left);
    const r = String(right);
    if (l.length + r.length >= w) {
      this.line(l);
      this.right(r);
      return;
    }
    const space = w - l.length - r.length;
    this.line(l + ' '.repeat(space) + r);
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
  e.row('VAT 12%', formatMoney(receipt.vat, sym));
  e.boldLine('');
  e.row('TOTAL', formatMoney(receipt.total, sym));
  e.bold(0);
  if (receipt.paymentMethod === 'cash') {
    e.row('Cash', formatMoney(receipt.tendered, sym));
    e.row('Change', formatMoney(receipt.change, sym));
  }
  e.separator();
  e.align(1);
  for (const l of String(receipt.footer).split('\n')) e.line(l);
  e.feed(2);
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
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function fmtQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(n);
}

module.exports = { Escpos, encodeReceipt, testPrint };
