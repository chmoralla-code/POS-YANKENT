'use strict';

/**
 * Shared margin cost rules for Generate Margin Table and Margin table Reports.
 * Selling price bands (VAT-inclusive catalog price):
 *   ≤ ₱100  → ₱10 unit profit
 *   ≤ ₱200  → ₱15
 *   > ₱200  → ₱20
 * Manual `margin_original_cost` overrides the automatic band when valid.
 */

const { round2 } = require('./money');

const MARGIN_RULES = Object.freeze([
  Object.freeze({ min_exclusive: null, max_inclusive: 100, unit_profit: 10 }),
  Object.freeze({ min_exclusive: 100, max_inclusive: 200, unit_profit: 15 }),
  Object.freeze({ min_exclusive: 200, max_inclusive: null, unit_profit: 20 }),
]);

function unitProfitFor(price) {
  if (price <= 100) return 10;
  if (price <= 200) return 15;
  return 20;
}

/**
 * Resolve unit cost (puhunan) from catalog selling price + optional manual override.
 * @param {number|string|null|undefined} sellingPrice
 * @param {number|string|null|undefined} marginOriginalCost
 * @returns {{
 *   selling_price: number|null,
 *   unit_cost: number|null,
 *   unit_profit: number|null,
 *   needs_manual_cost: boolean,
 *   cost_mode: 'auto'|'manual'|'pending'|'invalid',
 *   price_valid: boolean
 * }}
 */
function resolveUnitCost(sellingPrice, marginOriginalCost) {
  const price = round2(Number(sellingPrice));
  const priceOk = Number.isFinite(price) && price > 0;
  const autoProfit = priceOk ? unitProfitFor(price) : null;
  const canAutoCost = priceOk && price >= autoProfit;
  const hasManual = marginOriginalCost != null
    && marginOriginalCost !== ''
    && Number.isFinite(Number(marginOriginalCost));
  const manualCost = hasManual ? round2(Number(marginOriginalCost)) : null;
  const manualUsable = hasManual && priceOk && manualCost >= 0 && manualCost < price;

  if (manualUsable) {
    return {
      selling_price: price,
      unit_cost: manualCost,
      unit_profit: round2(price - manualCost),
      needs_manual_cost: false,
      cost_mode: 'manual',
      price_valid: true,
    };
  }
  if (canAutoCost) {
    return {
      selling_price: price,
      unit_cost: round2(price - autoProfit),
      unit_profit: autoProfit,
      needs_manual_cost: false,
      cost_mode: 'auto',
      price_valid: true,
    };
  }
  if (priceOk) {
    return {
      selling_price: price,
      unit_cost: null,
      unit_profit: null,
      needs_manual_cost: true,
      cost_mode: 'pending',
      price_valid: true,
    };
  }
  return {
    selling_price: null,
    unit_cost: null,
    unit_profit: null,
    needs_manual_cost: false,
    cost_mode: 'invalid',
    price_valid: false,
  };
}

module.exports = {
  MARGIN_RULES,
  unitProfitFor,
  resolveUnitCost,
};
