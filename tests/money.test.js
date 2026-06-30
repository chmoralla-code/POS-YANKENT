'use strict';
/* Tests: transaction totals & VAT (inclusive) calculation. */
const test = require('node:test');
const assert = require('node:assert');
const { computeTotals, computeChange, formatMoney, round2 } = require('../src/main/lib/money');

test('VAT-inclusive totals for a typical sale', () => {
  // 2 bags cement @280 + 3 hollow blocks @18 = 560 + 54 = 614
  const items = [{ qty: 2, unit_price: 280 }, { qty: 3, unit_price: 18 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.gross, 614);
  assert.equal(t.total, 614);
  assert.ok(Math.abs(t.subtotal - 548.21) < 0.01, 'subtotal ~548.21');
  assert.ok(Math.abs(t.vat - 65.79) < 0.01, 'vat ~65.79');
  // VAT-inclusive identity: subtotal + vat == total (after 2-dp rounding)
  assert.equal(round2(t.subtotal + t.vat), t.total);
});

test('bulk unit sale (sand: 1.5 cu.m @1200)', () => {
  const items = [{ qty: 1.5, unit_price: 1200 }];
  const t = computeTotals(items, { vatRate: 12 });
  assert.equal(t.total, 1800);
  assert.ok(Math.abs(t.subtotal - 1607.14) < 0.01);
  assert.ok(Math.abs(t.vat - 192.86) < 0.01);
});

test('discount and delivery fee', () => {
  const items = [{ qty: 1, unit_price: 1000 }];
  const t = computeTotals(items, { vatRate: 12, discount: 100, deliveryFee: 50 });
  // total = 1000 + 50 - 100 = 950
  assert.equal(t.total, 950);
  assert.equal(t.discount, 100);
  assert.equal(t.deliveryFee, 50);
  assert.equal(round2(t.subtotal + t.vat), t.total);
});

test('cash change calculation', () => {
  const c = computeChange(614, 700);
  assert.equal(c.change, 86);
  assert.equal(c.sufficient, true);
  const c2 = computeChange(614, 600);
  assert.equal(c2.sufficient, false);
  assert.equal(c2.change, -14);
});

test('money formatting', () => {
  assert.equal(formatMoney(1250, 'PHP'), 'PHP1,250.00');
  assert.equal(formatMoney(-1250, 'PHP'), '-PHP1,250.00');
  assert.equal(formatMoney(0, 'PHP'), 'PHP0.00');
});

test('round2 on VAT division results', () => {
  assert.equal(round2(65.7857142857), 65.79);
  assert.equal(round2(548.214285714), 548.21);
});
