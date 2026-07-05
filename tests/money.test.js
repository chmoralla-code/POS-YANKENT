'use strict';
/* Tests: transaction totals & VAT (EXCLUSIVE) calculation.
 * Item prices are NET (no VAT). VAT is ADDED on top of the subtotal. */
const test = require('node:test');
const assert = require('node:assert');
const { computeTotals, computeChange, formatMoney, round2 } = require('../src/main/lib/money');

test('VAT-exclusive totals for a typical sale', () => {
  // 2 bags cement @280 + 3 hollow blocks @18 = 560 + 54 = 614 (net)
  const items = [{ qty: 2, unit_price: 280 }, { qty: 3, unit_price: 18 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.gross, 614);
  assert.equal(t.subtotal, 614);              // net subtotal = gross (no discount)
  assert.equal(t.vat, 73.68);                 // 614 * 12% = 73.68
  assert.equal(t.total, 687.68);              // 614 + 73.68 = 687.68
  // VAT-exclusive identity: subtotal + vat == total
  assert.equal(round2(t.subtotal + t.vat), t.total);
});

test('bulk unit sale (sand: 1.5 cu.m @1200)', () => {
  const items = [{ qty: 1.5, unit_price: 1200 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.subtotal, 1800);             // net
  assert.equal(t.vat, 216);                   // 1800 * 12%
  assert.equal(t.total, 2016);                // 1800 + 216
});

test('discount and delivery fee (VAT-exclusive)', () => {
  const items = [{ qty: 1, unit_price: 1000 }];
  const t = computeTotals(items, { vatRate: 12, discount: 100, deliveryFee: 50 });
  // subtotal = 1000 + 50 - 100 = 950 (net)
  assert.equal(t.subtotal, 950);
  assert.equal(t.discount, 100);
  assert.equal(t.deliveryFee, 50);
  assert.equal(t.vat, 114);                   // 950 * 12%
  assert.equal(t.total, 1064);                // 950 + 114
  assert.equal(round2(t.subtotal + t.vat), t.total);
});

test('cash change calculation', () => {
  const c = computeChange(687.68, 700);
  assert.equal(c.change, 12.32);
  assert.equal(c.sufficient, true);
  const c2 = computeChange(687.68, 600);
  assert.equal(c2.sufficient, false);
  assert.equal(c2.change, -87.68);
});

test('money formatting', () => {
  assert.equal(formatMoney(1250, 'PHP'), 'PHP1,250.00');
  assert.equal(formatMoney(-1250, 'PHP'), '-PHP1,250.00');
  assert.equal(formatMoney(0, 'PHP'), 'PHP0.00');
});

test('round2 on VAT multiplication results', () => {
  assert.equal(round2(614 * 0.12), 73.68);
  assert.equal(round2(1800 * 0.12), 216);
  assert.equal(round2(950 * 0.12), 114);
});