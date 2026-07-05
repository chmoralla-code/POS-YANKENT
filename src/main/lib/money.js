'use strict';

/**
 * Money & VAT calculation utilities (pure, unit-tested).
 *
 * YANKENT POS uses VAT-EXCLUSIVE pricing: the item price is the NET price
 * (no VAT).  VAT is ADDED on top of the subtotal at checkout.
 *   subtotal = gross − discount + deliveryFee   (net amounts)
 *   vat      = subtotal × vatRate / 100
 *   total    = subtotal + vat                   (what the customer pays)
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

  // Net subtotal = item gross − discount + delivery fee.  VAT is added on
  // top of this net amount to produce the total the customer pays.
  const subtotal = round2(Math.max(0, gross + deliveryFee - discount));
  const vat = round2(subtotal * vatRate / 100);
  const total = round2(subtotal + vat);

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
