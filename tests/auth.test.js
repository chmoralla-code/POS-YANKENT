'use strict';
/* Tests: password hashing, sessions, and role-based permissions. */
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, createSession, getSession, logout, requireRole } = require('../src/main/lib/auth');
const { freshDb } = require('./dbutil');

test('password hash and verify', () => {
  const h = hashPassword('admin123');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('admin123', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('', h));
});

test('seeded admin password verifies against DB', async () => {
  const { db, close } = await freshDb();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  assert.ok(user);
  assert.equal(user.role, 'admin');
  assert.ok(verifyPassword('admin123', user.password_hash));
  const cashier = db.prepare('SELECT * FROM users WHERE username=?').get('maria');
  assert.ok(verifyPassword('cashier123', cashier.password_hash));
  close();
});

test('cashier cannot pass admin role gate; admin can', () => {
  const admin = { id: 1, username: 'admin', full_name: 'A', role: 'admin' };
  const cashier = { id: 2, username: 'maria', full_name: 'M', role: 'cashier' };
  assert.doesNotThrow(() => requireRole(admin, 'admin'));
  assert.doesNotThrow(() => requireRole(admin, 'cashier'));
  assert.doesNotThrow(() => requireRole(cashier, 'cashier'));
  assert.throws(() => requireRole(cashier, 'admin'), /Administrator/i);
  assert.throws(() => requireRole(null, 'admin'), /authenticated/i);
});

test('session lifecycle', () => {
  const s = createSession({ id: 1, username: 'admin', full_name: 'A', role: 'admin' });
  assert.ok(s.token);
  assert.equal(getSession(s.token).role, 'admin');
  logout(s.token);
  assert.equal(getSession(s.token), null);
});
