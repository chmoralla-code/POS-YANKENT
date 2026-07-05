'use strict';
/* Tests: auth edge cases — inactive user, wrong password, session reuse
 * after logout, and admin-only guard on a real IPC channel. */
const test = require('node:test');
const assert = require('node:assert');
const { createSession, getSession, logout } = require('../src/main/lib/auth');
const { makeApi } = require('./ipc-harness');

async function setup() {
  const api = await makeApi();
  return { api };
}

async function login(api, username, password) {
  // The login handler is registered via ipcMain.handle (not guard), so it
  // returns the raw { ok, data | error } envelope.
  const fn = api._handler('pos:auth:login');
  return fn({}, { username, password });
}

test('valid login returns a token + user', async () => {
  const t = await setup();
  const r = await login(t.api, 'admin', 'admin123');
  assert.equal(r.ok, true);
  assert.ok(r.data.token);
  assert.equal(r.data.user.role, 'admin');
  t.api.close();
});

test('wrong password is rejected', async () => {
  const t = await setup();
  const r = await login(t.api, 'admin', 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUTH');
  t.api.close();
});

test('unknown user is rejected with the same error (no enumeration)', async () => {
  const t = await setup();
  const r = await login(t.api, 'nobody', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUTH');
  assert.equal(r.error, 'Invalid username or password');
  t.api.close();
});

test('inactive user cannot log in', async () => {
  const t = await setup();
  t.api.db.prepare('UPDATE users SET active=0 WHERE username=?').run('cashier');
  const r = await login(t.api, 'cashier', 'cashier123');
  assert.equal(r.ok, false);
  t.api.close();
});

test('session token is invalid after logout', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  assert.ok(getSession(s.token));
  logout(s.token);
  assert.equal(getSession(s.token), null);
  t.api.close();
});

test('admin-only IPC channel rejects a cashier session', async () => {
  const t = await setup();
  const cashier = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const cashierSession = createSession(cashier);
  await assert.rejects(() => t.api.call('pos:users:list', cashierSession), /Administrator/i);
  t.api.close();
});

test('admin-only IPC channel rejects a null (unauthenticated) session', async () => {
  const t = await setup();
  await assert.rejects(() => t.api.call('pos:users:list', null), /authenticated/i);
  t.api.close();
});

test('pos:users:delete refuses to delete the only active admin', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  await assert.rejects(() => t.api.call('pos:users:delete', s, admin.id), /only active admin/i);
  t.api.close();
});

test('pos:users:delete hard-deletes a user with no history', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  // Create a new cashier (no history)
  const r = await t.api.call('pos:users:create', s, {
    username: 'tempuser', password: 'temp1234', full_name: 'Temp User', role: 'cashier',
  });
  const before = t.api.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const result = await t.api.call('pos:users:delete', s, r.id);
  assert.equal(result.deleted, true);
  assert.equal(result.deactivated, false);
  const after = t.api.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  assert.equal(after, before - 1);
  t.api.close();
});

test('pos:users:delete soft-deletes (deactivates) a user with sales history', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  // Create a cashier
  const cr = await t.api.call('pos:users:create', s, {
    username: 'historyuser', password: 'hist1234', full_name: 'History User', role: 'cashier',
  });
  // Create a sale as the cashier so they have history
  const cashierSession = createSession(t.api.db.prepare('SELECT * FROM users WHERE id=?').get(cr.id));
  const cement = t.api.db.prepare('SELECT * FROM products WHERE sku=?').get('CMT-001');
  const sale = await t.api.call('pos:sales:create', cashierSession, {
    items: [{ productId: cement.id, sku: cement.sku, name: cement.name, unit: 'bag', qty: 1, unitPrice: 280, factor: 1 }],
    paymentMethod: 'cash', amountTendered: 400,
  });
  await t.api.call('pos:sales:commit', cashierSession, sale.txnId);
  // Now try to delete — should deactivate, not hard-delete
  const result = await t.api.call('pos:users:delete', s, cr.id);
  assert.equal(result.deleted, false);
  assert.equal(result.deactivated, true);
  // User still exists, but is inactive
  const still = t.api.db.prepare('SELECT active FROM users WHERE id=?').get(cr.id);
  assert.equal(still.active, 0);
  t.api.close();
});

test('pos:users:delete rejects cashier (admin-only)', async () => {
  const t = await setup();
  const cashier = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const s = createSession(cashier);
  await assert.rejects(() => t.api.call('pos:users:delete', s, 999), /Administrator/i);
  t.api.close();
});

test('auth channel returns the session for a valid token', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  const session = await t.api.call('pos:auth:session', s);
  assert.equal(session.username, 'admin');
  assert.equal(session.role, 'admin');
  t.api.close();
});