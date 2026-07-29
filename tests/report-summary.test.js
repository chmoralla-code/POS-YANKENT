'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const { buildReportSummary } = require('../src/main/lib/report-summary');
const { buildReportMessage, buildAnalytics } = require('../src/main/lib/telegram');

async function setup() {
  const api = await makeApi();
  const cashier = api.db.prepare("SELECT * FROM users WHERE username='cashier'").get();
  const contractor = api.db.prepare("SELECT * FROM customers WHERE name=?").get('ABC Construction');
  return {
    api,
    cashierSession: createSession(cashier),
    contractor,
  };
}

async function makeCashSale(api, session, qty = 1) {
  const cement = api.db.prepare("SELECT * FROM products WHERE sku=?").get('CMT-001');
  const res = await api.call('pos:sales:create', session, {
    items: [{
      productId: cement.id, sku: cement.sku, name: cement.name,
      unit: 'bag', qty, unitPrice: 280, factor: 1,
    }],
    paymentMethod: 'cash',
    amountTendered: 99999,
  });
  await api.call('pos:sales:commit', session, res.txnId);
  return res;
}

async function makeUtangSale(api, session, contractor, qty = 1) {
  const cement = api.db.prepare("SELECT * FROM products WHERE sku=?").get('CMT-001');
  const due = new Date();
  due.setDate(due.getDate() + 7);
  const dueDate = due.toISOString().slice(0, 10);
  const res = await api.call('pos:sales:create', session, {
    items: [{
      productId: cement.id, sku: cement.sku, name: cement.name,
      unit: 'bag', qty, unitPrice: 280, factor: 1,
    }],
    paymentMethod: 'account',
    customerId: contractor.id,
    customerName: contractor.name,
    dueDate,
    amountTendered: 0,
  });
  await api.call('pos:sales:commit', session, res.txnId);
  return res;
}

test('report summary splits paid sales from utang (on-account)', async () => {
  const t = await setup();
  await makeCashSale(t.api, t.cashierSession, 1); // 280
  await makeUtangSale(t.api, t.cashierSession, t.contractor, 2); // 560

  const summary = buildReportSummary(t.api.db);
  assert.equal(summary.today.total, 840);
  assert.equal(summary.today.tx, 2);
  assert.equal(summary.separateUtang, false);
  assert.equal(summary.combined.today.total, 840);
  assert.equal(summary.sales.today.total, 280);
  assert.equal(summary.sales.today.tx, 1);
  assert.equal(summary.utang.today.total, 560);
  assert.equal(summary.utang.today.tx, 1);

  const viaIpc = await t.api.call(
    'pos:reports:summary',
    createSession(t.api.db.prepare("SELECT * FROM users WHERE username='admin'").get())
  );
  assert.equal(viaIpc.sales.today.total, 280);
  assert.equal(viaIpc.utang.today.total, 560);
  t.api.close();
});

test('telegram sales totals exclude utang and list utang separately', async () => {
  const t = await setup();
  await makeCashSale(t.api, t.cashierSession, 1);
  await makeUtangSale(t.api, t.cashierSession, t.contractor, 2);
  await t.api.call(
    'pos:reports:setUtangSeparation',
    t.cashierSession,
    true
  );
  const analytics = buildAnalytics(t.api.db);
  assert.deepEqual(
    analytics.payBreakCombined.map((row) => row.payment_method).sort(),
    ['account', 'cash'],
  );
  assert.deepEqual(
    analytics.payBreak.map((row) => row.payment_method),
    ['cash'],
  );
  assert.equal(analytics.topCashierCombined.total, 840);
  assert.equal(analytics.topCashier.total, 280);
  assert.equal(analytics.topCashierSales.total, 280);

  const msg = buildReportMessage(t.api.db);
  assert.ok(msg.includes('Sales exclude Utang'));
  assert.ok(msg.includes('Utang (On-Account)'));
  // Cash 280 should appear in sales Today line (before Utang section).
  const salesBlock = msg.split('Utang (On-Account)')[0];
  assert.ok(/Today:.*280\.00/.test(salesBlock) || /Today:.*₱280/.test(salesBlock) || salesBlock.includes('280'));
  const utangBlock = msg.split('Utang (On-Account)')[1];
  assert.ok(utangBlock.includes('560') || /Today:.*560/.test(utangBlock));
  const paymentLine = msg.split('\n').find((line) => line.startsWith('Payments:'));
  assert.ok(paymentLine && paymentLine.includes('cash'));
  assert.ok(!paymentLine.includes('account'));
  const topCashierLine = msg.split('\n').find((line) => line.startsWith('Top Cashier:'));
  assert.ok(topCashierLine && topCashierLine.includes('280'));
  assert.ok(!topCashierLine.includes('840'));
  t.api.close();
});

test('Separate is a persisted report-wide switch and off restores combined totals', async () => {
  const t = await setup();
  await makeCashSale(t.api, t.cashierSession, 1);
  await makeUtangSale(t.api, t.cashierSession, t.contractor, 2);

  const initial = await t.api.call(
    'pos:reports:utangSeparation',
    t.cashierSession
  );
  assert.deepEqual(initial, { enabled: false, configured: false });

  const enabled = await t.api.call(
    'pos:reports:setUtangSeparation',
    t.cashierSession,
    true
  );
  assert.deepEqual(enabled, { enabled: true, configured: true });

  const summary = await t.api.call(
    'pos:reports:summary',
    t.cashierSession
  );
  assert.equal(summary.separateUtang, true);
  assert.equal(summary.today.total, 280);
  assert.equal(summary.combined.today.total, 840);
  assert.equal(summary.utang.today.total, 560);

  const [best, cashiers, days, sales, recent, analytics] = await Promise.all([
    t.api.call('pos:reports:bestSelling', t.cashierSession, {}),
    t.api.call('pos:reports:byCashier', t.cashierSession, {}),
    t.api.call('pos:reports:salesByDay', t.cashierSession, {}),
    t.api.call('pos:sales:list', t.cashierSession, {}),
    t.api.call('pos:sales:recent', t.cashierSession, 10),
    t.api.call('pos:reports:analytics', t.cashierSession),
  ]);
  assert.equal(best[0].total, 280);
  assert.equal(best[0].qty, 1);
  assert.equal(cashiers[0].total, 280);
  assert.equal(cashiers[0].tx, 1);
  assert.equal(days[0].total, 280);
  assert.equal(days[0].tx, 1);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].payment_method, 'cash');
  assert.deepEqual(
    recent.map((sale) => sale.payment_method).sort(),
    ['account', 'cash'],
    'operational recent-sales history must keep Utang'
  );
  assert.equal(
    t.api.db.prepare("SELECT COUNT(*) AS c FROM loans WHERE state='open'").get().c,
    1,
    'Separate must not change the Utang loan ledger'
  );
  assert.equal(analytics.today.total, 280);
  assert.deepEqual(
    analytics.payBreak.map((row) => row.payment_method),
    ['cash']
  );

  await t.api.call(
    'pos:reports:setUtangSeparation',
    t.cashierSession,
    false
  );
  const restored = await t.api.call(
    'pos:reports:summary',
    t.cashierSession
  );
  assert.equal(restored.separateUtang, false);
  assert.equal(restored.today.total, 840);
  const restoredSales = await t.api.call(
    'pos:sales:list',
    t.cashierSession,
    {}
  );
  assert.deepEqual(
    restoredSales.map((sale) => sale.payment_method).sort(),
    ['account', 'cash']
  );
  const combinedMessage = buildReportMessage(t.api.db);
  assert.ok(!combinedMessage.includes('Sales exclude Utang'));
  assert.ok(!combinedMessage.includes('Utang (On-Account)'));
  assert.ok(combinedMessage.split('\n').some((line) => line.startsWith('📅 Today:') && line.includes('840')));
  const combinedPaymentLine = combinedMessage.split('\n').find((line) => line.startsWith('Payments:'));
  assert.ok(combinedPaymentLine.includes('account'));

  t.api.close();
});
