'use strict';
/* Tests: transaction totals & VAT-INCLUSIVE calculation.
 * Item prices are what the customer pays; VAT is split out, not added. */
const test = require('node:test');
const assert = require('node:assert');
const { computeTotals, computeChange, formatMoney, round2 } = require('../src/main/lib/money');

test('VAT-inclusive totals for a typical sale', () => {
  // 2 bags cement @280 + 3 hollow blocks @18 = 560 + 54 = 614 paid
  const items = [{ qty: 2, unit_price: 280 }, { qty: 3, unit_price: 18 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.gross, 614);
  assert.equal(t.subtotal, 548.21);           // 614 / 1.12
  assert.equal(t.vat, 65.79);                 // VAT component already in 614
  assert.equal(t.total, 614);                 // customer pays catalog prices
  assert.equal(round2(t.subtotal + t.vat), t.total);
});

test('bulk unit sale (sand: 1.5 cu.m @1200)', () => {
  const items = [{ qty: 1.5, unit_price: 1200 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.subtotal, 1607.14);
  assert.equal(t.vat, 192.86);
  assert.equal(t.total, 1800);
});

test('discount and delivery fee remain VAT-inclusive', () => {
  const items = [{ qty: 1, unit_price: 1000 }];
  const t = computeTotals(items, { vatRate: 12, discount: 100, deliveryFee: 50 });
  // Customer pays 1000 + 50 - 100 = 950; split VAT from that amount.
  assert.equal(t.subtotal, 848.21);
  assert.equal(t.discount, 100);
  assert.equal(t.deliveryFee, 50);
  assert.equal(t.vat, 101.79);
  assert.equal(t.total, 950);
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

test('invalid monetary inputs are rejected instead of producing NaN totals', () => {
  assert.throws(() => computeTotals([{ amount: Number.NaN }], { vatRate: 12 }), /Invalid line amount/);
  assert.throws(() => computeTotals([{ amount: 10 }], { vatRate: -1 }), /Invalid VAT rate/);
  assert.throws(() => computeTotals([{ amount: 10 }], { discount: -1 }), /Invalid discount/);
});
