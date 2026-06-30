'use strict';

/**
 * Money & VAT calculation utilities (pure, unit-tested).
 *
 * YANKENT POS uses VAT-INCLUSIVE pricing (Philippines, 12%): the displayed
 * item price already includes VAT. The "total" charged to the customer is the
 * sum of line amounts (+ delivery, − discount). Net subtotal and VAT are
 * derived: subtotal = total / (1 + vatRate/100), vat = total − subtotal.
 */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Compute sale totals from a list of cart items.
 * @param {Array<{qty:number, unit_price:number, amount?:number}>} items
 * @param {{vatRate?:number, discount?:number, deliveryFee?:number}} opts
 */
function computeTotals(items, opts = {}) {
  const vatRate = Number(opts.vatRate ?? 12);
  const discount = Number(opts.discount ?? 0);
  const deliveryFee = Number(opts.deliveryFee ?? 0);

  const gross = items.reduce((s, i) => {
    const line = i.amount != null ? Number(i.amount) : round2(Number(i.qty) * Number(i.unit_price));
    return s + line;
  }, 0);

  const total = Math.max(0, round2(gross + deliveryFee - discount));
  const subtotal = round2(total / (1 + vatRate / 100));
  const vat = round2(total - subtotal);

  return { gross: round2(gross), discount: round2(discount), deliveryFee: round2(deliveryFee), subtotal, vat, total };
}

/**
 * Cash change calculation.
 */
function computeChange(total, tendered) {
  const t = Number(tendered || 0);
  const change = round2(t - Number(total));
  return { tendered: t, change, sufficient: change >= -1e-9 };
}

/**
 * Format a money amount with symbol, e.g. "PHP 1,250.00" or "₱1,250.00".
 */
function formatMoney(n, symbol = 'PHP') {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-' : '') + symbol + s;
}

module.exports = { round2, computeTotals, computeChange, formatMoney };
