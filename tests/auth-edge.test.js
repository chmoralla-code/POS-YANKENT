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

test('admin-only IPC channels enforce the configured idle timeout', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  t.api.db.prepare("UPDATE settings SET value='1' WHERE key='session_idle_timeout'").run();
  s.lastActivity = Date.now() - 61 * 1000;
  await assert.rejects(
    () => t.api.call('pos:users:list', s),
    (err) => err.code === 'SESSION_EXPIRED' && /expired/i.test(err.message)
  );
  t.api.close();
});

test('user management rejects lockout, invalid roles, and weak passwords', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const s = createSession(admin);
  await assert.rejects(() => t.api.call('pos:users:update', s, admin.id, {
    full_name: admin.full_name, role: 'cashier', active: 1,
  }), /cannot deactivate or demote/i);
  await assert.rejects(() => t.api.call('pos:users:create', s, {
    username: 'badrole', password: 'valid-password', full_name: 'Bad Role', role: 'owner',
  }), /Invalid user role/);
  await assert.rejects(() => t.api.call('pos:users:create', s, {
    username: 'weak', password: '123', full_name: 'Weak Password', role: 'cashier',
  }), /at least 4 characters/);
  await assert.rejects(() => t.api.call('pos:users:setPassword', s, admin.id, ''), /at least 4 characters/);
  t.api.close();
});

test('an inactive secondary admin can be deleted without triggering active-admin lockout', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const session = createSession(admin);
  const created = await t.api.call('pos:users:create', session, {
    username: 'oldadmin', password: 'oldadmin123', full_name: 'Old Admin', role: 'admin',
  });
  t.api.db.prepare('UPDATE users SET active=0 WHERE id=?').run(created.id);
  const result = await t.api.call('pos:users:delete', session, created.id);
  assert.equal(result.deleted, true);
  assert.equal(t.api.db.prepare('SELECT id FROM users WHERE id=?').get(created.id), undefined);
  t.api.close();
});

test('passive heartbeat expires an idle session but timeout zero stays disabled', async () => {
  const t = await setup();
  const heartbeat = t.api._handler('pos:auth:heartbeat');
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');

  t.api.db.prepare("UPDATE settings SET value='1' WHERE key='session_idle_timeout'").run();
  const expired = createSession(admin);
  expired.lastActivity = Date.now() - 61 * 1000;
  const expiredResult = await heartbeat({}, expired.token, false);
  assert.equal(expiredResult.ok, true);
  assert.equal(expiredResult.data.alive, false);
  assert.equal(getSession(expired.token), null);

  t.api.db.prepare("UPDATE settings SET value='0' WHERE key='session_idle_timeout'").run();
  const disabled = createSession(admin);
  disabled.lastActivity = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const disabledResult = await heartbeat({}, disabled.token, false);
  assert.equal(disabledResult.data.alive, true);
  assert.ok(getSession(disabled.token));
  logout(disabled.token);
  t.api.close();
});

test('protected calls revoke deactivated users and refresh changed roles', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');

  const deactivated = createSession(admin);
  t.api.db.prepare('UPDATE users SET active=0 WHERE id=?').run(admin.id);
  await assert.rejects(
    () => t.api.call('pos:auth:session', deactivated),
    (error) => error.code === 'SESSION_EXPIRED'
  );
  assert.equal(getSession(deactivated.token), null);

  t.api.db.prepare("UPDATE users SET active=1, role='admin' WHERE id=?").run(admin.id);
  const demoted = createSession(t.api.db.prepare('SELECT * FROM users WHERE id=?').get(admin.id));
  t.api.db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(admin.id);
  await assert.rejects(() => t.api.call('pos:users:list', demoted), /Administrator/i);
  assert.equal(demoted.role, 'cashier');
  logout(demoted.token);
  t.api.close();
});

test('cashiers cannot read Telegram credentials and invalid settings are rejected', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const adminSession = createSession(admin);
  const cashierSession = createSession(cashier);
  await t.api.call('pos:settings:set', adminSession, 'telegram_token', 'secret-token');
  await t.api.call('pos:settings:set', adminSession, 'telegram_chat_id', '123456');

  const cashierSettings = await t.api.call('pos:settings:getAll', cashierSession);
  assert.equal(cashierSettings.telegram_token, '');
  assert.equal(cashierSettings.telegram_chat_id, '');
  const adminSettings = await t.api.call('pos:settings:getAll', adminSession);
  assert.equal(adminSettings.telegram_token, 'secret-token');

  await assert.rejects(() => t.api.call('pos:settings:set', adminSession, 'vat_rate', '-1'), /Invalid value/);
  await assert.rejects(() => t.api.call('pos:settings:set', adminSession, 'receipt_width', '80'), /32 or 48/);
  await assert.rejects(() => t.api.call('pos:settings:set', adminSession, 'invented_setting', '1'), /Unknown setting/);
  assert.equal(t.api.db.prepare("SELECT value FROM settings WHERE key='vat_rate'").get().value, '12');
  t.api.close();
});

test('administrator password reset revokes the affected user sessions', async () => {
  const t = await setup();
  const admin = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  const cashier = t.api.db.prepare('SELECT * FROM users WHERE username=?').get('cashier');
  const adminSession = createSession(admin);
  const cashierSession = createSession(cashier);
  await t.api.call('pos:users:setPassword', adminSession, cashier.id, 'new-cashier-password');
  await assert.rejects(
    () => t.api.call('pos:auth:session', cashierSession),
    (error) => error.code === 'SESSION_EXPIRED' && /revoked/i.test(error.message)
  );
  t.api.close();
});
