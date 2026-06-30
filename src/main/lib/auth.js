'use strict';

const crypto = require('crypto');

/**
 * Hash a password using scrypt. Stored format: `scrypt$<salt>$<hash>`.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Verify a password against a stored scrypt hash. Constant-time compare.
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// In-memory sessions (single-window desktop app; cleared on app exit).
// token -> { id, username, full_name, role, token, createdAt }
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    createdAt: Date.now(),
  };
  sessions.set(token, session);
  return session;
}

function getSession(token) {
  if (!token) return null;
  return sessions.get(token) || null;
}

function logout(token) {
  if (token) sessions.delete(token);
}

/**
 * Throw a permission error if the session lacks the required role.
 * @param {object|null} session - from getSession(token)
 * @param {'admin'|'cashier'} role
 */
function requireRole(session, role) {
  if (!session) {
    const err = new Error('Not authenticated');
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  if (role && session.role !== role && session.role !== 'admin') {
    // 'admin' always passes; cashier only passes when role === 'cashier'
    if (role === 'admin') {
      const err = new Error('Administrator access required');
      err.code = 'FORBIDDEN';
      throw err;
    }
  }
  return session;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  logout,
  requireRole,
};
