'use strict';

/**
 * Money & VAT calculation utilities (pure, unit-tested).
 *
 * YANKENT POS uses VAT-INCLUSIVE pricing: the item price is what the
 * customer pays. VAT is split out for receipts and reporting; it is never
 * added on top at checkout.
 *   total    = gross − discount + deliveryFee
 *   subtotal = total / (1 + vatRate / 100)
 *   vat      = total − subtotal
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

  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) throw new Error('Invalid VAT rate');
  if (!Number.isFinite(discount) || discount < 0) throw new Error('Invalid discount');
  if (!Number.isFinite(deliveryFee) || deliveryFee < 0) throw new Error('Invalid delivery fee');

  const gross = items.reduce((s, i) => {
    const line = i.amount != null ? Number(i.amount) : round2(Number(i.qty) * Number(i.unit_price));
    if (!Number.isFinite(line) || line < 0) throw new Error('Invalid line amount');
    return s + line;
  }, 0);

  // Catalog prices already include VAT. Split the final amount into its net
  // and VAT components without changing what the customer pays.
  const total = round2(Math.max(0, gross + deliveryFee - discount));
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
