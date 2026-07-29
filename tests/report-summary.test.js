'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSession } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');
const { buildReportSummary } = require('../src/main/lib/report-summary');
const { buildReportMessage } = require('../src/main/lib/telegram');

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
  const msg = buildReportMessage(t.api.db);
  assert.ok(msg.includes('Sales exclude Utang'));
  assert.ok(msg.includes('Utang (On-Account)'));
  // Cash 280 should appear in sales Today line (before Utang section).
  const salesBlock = msg.split('Utang (On-Account)')[0];
  assert.ok(/Today:.*280\.00/.test(salesBlock) || /Today:.*₱280/.test(salesBlock) || salesBlock.includes('280'));
  const utangBlock = msg.split('Utang (On-Account)')[1];
  assert.ok(utangBlock.includes('560') || /Today:.*560/.test(utangBlock));
  t.api.close();
});
