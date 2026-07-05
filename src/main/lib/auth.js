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
// token -> { id, username, full_name, role, token, createdAt, lastActivity }
const sessions = new Map();

// Default idle timeout in milliseconds (15 minutes). Overridable via the
// `session_idle_timeout` setting (in minutes).
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    createdAt: now,
    lastActivity: now,
  };
  sessions.set(token, session);
  return session;
}

/** Update the last-activity timestamp so the session stays alive. */
function touchSession(token) {
  const s = sessions.get(token);
  if (s) s.lastActivity = Date.now();
}

/** Check if a session is still valid given the configured idle timeout. */
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  return s;
}

/** Returns true if the session has exceeded the idle timeout. */
function isSessionExpired(token, idleTimeoutMs) {
  const s = sessions.get(token);
  if (!s) return true;
  const timeout = idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
  return (Date.now() - s.lastActivity) > timeout;
}

function logout(token) {
  if (token) sessions.delete(token);
}

/**
 * Throw a permission error if the session lacks the required role.
 * @param {object|null} session - from getSession(token)
 * @param {'admin'|'cashier'|null} role - required role, or null for any logged-in user
 */
function requireRole(session, role) {
  if (!session) {
    const err = new Error('Not authenticated');
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  if (!role) return session;            // any logged-in user is fine
  if (session.role === 'admin') return session;  // admin passes every role gate
  if (session.role !== role) {
    const err = new Error(role === 'admin' ? 'Administrator access required' : 'Permission denied');
    err.code = 'FORBIDDEN';
    throw err;
  }
  return session;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  touchSession,
  isSessionExpired,
  logout,
  requireRole,
  DEFAULT_IDLE_TIMEOUT_MS,
};
