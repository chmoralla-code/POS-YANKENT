'use strict';

/**
 * IPC registration for the main process. Exposes a guarded bridge so the
 * renderer talks to the local SQLite DB through a small, validated API.
 *
 * Every protected channel receives the session token as its first argument
 * (prepended automatically by the preload bridge) and returns a uniform
 * { ok, data } | { ok:false, error, code } envelope.
 */

function makeGuard({ getSession, requireRole, touchSession, isSessionExpired, getSetting, db }) {
  return function guard(ipcMain, channel, opts, handler) {
    ipcMain.handle(channel, async (event, token, ...args) => {
      try {
        const session = getSession(token);
        // Check idle timeout for authenticated endpoints.
        if (opts && (opts.auth || opts.admin) && session) {
          const idleMin = Number(getSetting(db, 'session_idle_timeout') || '15');
          if (idleMin > 0 && isSessionExpired(token, idleMin * 60 * 1000)) {
            // Session expired — force re-authentication.
            const err = new Error('Session expired due to inactivity');
            err.code = 'SESSION_EXPIRED';
            throw err;
          }
          touchSession(token);
        }
        if (opts && opts.admin) requireRole(session, 'admin');
        else if (opts && opts.auth) requireRole(session, null); // any logged-in user
        const data = await handler({ event, session }, ...args);
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'ERROR' };
      }
    });
  };
}

function registerAll(ipcMain, ctx) {
  let backendReady = false;
  ipcMain.handle('pos:app:isReady', () => ({ ok: true, data: backendReady }));

  const { db } = ctx;
  const crypto = require('crypto');
  const { verifyPassword, createSession, logout, hashPassword, touchSession, isSessionExpired, DEFAULT_IDLE_TIMEOUT_MS } = require('../lib/auth');
  const { checkOnline, sendApprovalRequest, pollUpdates, answerCallback, deleteWebhook } = require('../lib/telegram');

  const guard = makeGuard({ ...ctx, touchSession, isSessionExpired });

  // In-memory pending password-reset requests (token -> {userId, username, status, createdAt})
  const pendingResets = new Map();
  let tgOffset = 0;
  let webhookCleared = false;

  // ---- Auth --------------------------------------------------------------
  ipcMain.handle('pos:auth:login', async (_e, { username, password }) => {
    const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return { ok: false, error: 'Invalid username or password', code: 'AUTH' };
    }
    const session = createSession(user);
    return { ok: true, data: { token: session.token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } } };
  });

  ipcMain.handle('pos:auth:logout', async (_e, token) => { logout(token); return { ok: true, data: true }; });

  // ---- Session heartbeat (idle timeout) ---------------------------------
  // The renderer calls this on every user activity (mouse/keyboard) to
  // keep the session alive.  Returns whether the session is still valid.
  ipcMain.handle('pos:auth:heartbeat', async (_e, token) => {
    if (!token) return { ok: true, data: { alive: false } };
    const idleMin = Number(ctx.getSetting(db, 'session_idle_timeout') || '15');
    const idleMs = (idleMin > 0 ? idleMin : 15) * 60 * 1000;
    if (isSessionExpired(token, idleMs)) {
      logout(token);
      return { ok: true, data: { alive: false } };
    }
    touchSession(token);
    return { ok: true, data: { alive: true } };
  });

  // ---- Forgot password (public — no session required) -------------------
  ipcMain.handle('pos:auth:requestPasswordReset', async (_e, username) => {
    try {
      const user = db.prepare('SELECT id, username, full_name FROM users WHERE username=? AND active=1').get(username);
      if (!user) return { ok: false, error: 'User not found' };
      const token = crypto.randomBytes(4).toString('hex');
      pendingResets.set(token, { userId: user.id, username: user.username, status: 'pending', createdAt: Date.now() });
      const tgToken = ctx.getSetting(db, 'telegram_token');
      const chatId = ctx.getSetting(db, 'telegram_chat_id');
      if (!tgToken || !chatId) return { ok: false, error: 'Telegram is not configured. Contact an administrator.' };
      const online = await checkOnline();
      if (!online) return { ok: false, error: 'No internet — cannot send approval request.' };
      if (!webhookCleared) { await deleteWebhook(tgToken); webhookCleared = true; }
      const r = await sendApprovalRequest(tgToken, chatId, token, user.username);
      if (!r.ok) return { ok: false, error: r.description || 'Failed to send Telegram request' };
      return { ok: true, data: { token, username: user.username } };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('pos:auth:checkResetApproval', async (_e, token) => {
    try {
      const req = pendingResets.get(token);
      if (!req) return { ok: true, data: { status: 'expired' } };
      if (req.status !== 'pending') return { ok: true, data: { status: req.status } };
      if (Date.now() - req.createdAt > 10 * 60 * 1000) { pendingResets.delete(token); return { ok: true, data: { status: 'expired' } }; }
      // Poll Telegram once for the admin's button press.
      const tgToken = ctx.getSetting(db, 'telegram_token');
      if (!tgToken) return { ok: true, data: { status: 'pending' } };
      const r = await pollUpdates(tgToken, tgOffset, 5);
      if (r.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          if (u.update_id >= tgOffset) tgOffset = u.update_id + 1;
          const cq = u.callback_query;
          if (cq && cq.data) {
            const parts = cq.data.split(':'); // reset:approve:<token> | reset:deny:<token>
            if (parts[0] === 'reset' && parts[2]) {
              const pr = pendingResets.get(parts[2]);
              if (pr && pr.status === 'pending') {
                pr.status = parts[1] === 'approve' ? 'approved' : 'denied';
                await answerCallback(tgToken, cq.id, parts[1] === 'approve' ? '✅ Approved' : '❌ Denied');
              } else {
                await answerCallback(tgToken, cq.id, 'Request no longer valid');
              }
            }
          }
        }
      }
      return { ok: true, data: { status: req.status } };
    } catch (e) { return { ok: true, data: { status: 'pending' } }; }
  });

  ipcMain.handle('pos:auth:resetPassword', async (_e, token, newPassword) => {
    try {
      const req = pendingResets.get(token);
      if (!req) return { ok: false, error: 'Invalid or expired reset token' };
      if (req.status !== 'approved') return { ok: false, error: 'Reset has not been approved' };
      if (!newPassword || newPassword.length < 4) return { ok: false, error: 'Password must be at least 4 characters' };
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.userId);
      pendingResets.delete(token);
      return { ok: true, data: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  guard(ipcMain, 'pos:auth:session', { auth: true }, ({ session }) => {
    if (!session) return null;
    return { id: session.id, username: session.username, full_name: session.full_name, role: session.role };
  });

  // ---- Users (admin) -----------------------------------------------------
  guard(ipcMain, 'pos:users:list', { admin: true }, () => {
    return db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id').all();
  });

  guard(ipcMain, 'pos:users:create', { admin: true }, (_c, u = {}) => {
    const username = String(u.username || '').trim();
    const fullName = String(u.full_name || '').trim();
    const password = String(u.password || '');
    const role = String(u.role || '');
    if (!username) throw new Error('Username is required');
    if (!fullName) throw new Error('Full name is required');
    if (password.length < 4) throw new Error('Password must be at least 4 characters');
    if (!['admin', 'cashier'].includes(role)) throw new Error('Invalid user role');
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exists) throw new Error('Username already exists');
    const info = db.prepare(
      'INSERT INTO users(username, password_hash, full_name, role, active) VALUES(?,?,?,?,1)'
    ).run(username, hashPassword(password), fullName, role);
    return { id: info.lastInsertRowid };
  });

  guard(ipcMain, 'pos:users:update', { admin: true }, ({ session }, id, u = {}) => {
    const target = db.prepare('SELECT id, role, active FROM users WHERE id=?').get(id);
    if (!target) throw new Error('User not found');
    const fullName = String(u.full_name || '').trim();
    const role = String(u.role || '');
    const active = u.active ? 1 : 0;
    if (!fullName) throw new Error('Full name is required');
    if (!['admin', 'cashier'].includes(role)) throw new Error('Invalid user role');
    if (session && session.id === target.id && (!active || role !== 'admin')) {
      throw new Error('You cannot deactivate or demote your own account');
    }
    if (target.role === 'admin' && target.active && (!active || role !== 'admin')) {
      const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").get().c;
      if (adminCount <= 1) throw new Error('Cannot deactivate or demote the only active admin');
    }
    db.prepare('UPDATE users SET full_name=?, role=?, active=? WHERE id=?')
      .run(fullName, role, active, target.id);
    return true;
  });

  // Delete a user.  Hard-deletes when the user has no sales/refund/movement
  // history; otherwise soft-deletes (sets active=0) to preserve audit trails.
  guard(ipcMain, 'pos:users:delete', { admin: true }, (_c, id) => {
    if (!id) throw new Error('User id is required');
    const target = db.prepare('SELECT username, role FROM users WHERE id=?').get(id);
    if (!target) throw new Error('User not found');
    // Refuse to delete the only remaining admin — prevents lockout.
    if (target.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").get().c;
      if (adminCount <= 1) throw new Error('Cannot delete the only active admin');
    }
    // Refuse to delete the currently-logged-in user.
    const me = _c.session;
    if (me && me.id === id) throw new Error('You cannot delete your own account');
    const hasHistory =
      db.prepare('SELECT 1 FROM sales WHERE cashier_id=? LIMIT 1').get(id) ||
      db.prepare('SELECT 1 FROM refunds WHERE cashier_id=? OR admin_id=? LIMIT 1').get(id, id) ||
      db.prepare('SELECT 1 FROM stock_movements WHERE user_id=? LIMIT 1').get(id);
    if (hasHistory) {
      // Soft delete — preserves audit trail integrity.
      db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
      return { deleted: false, deactivated: true, reason: 'User has sales/movement history — deactivated instead' };
    }
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    return { deleted: true, deactivated: false };
  });

  guard(ipcMain, 'pos:users:setPassword', { admin: true }, (_c, id, password) => {
    const value = String(password || '');
    if (value.length < 4) throw new Error('Password must be at least 4 characters');
    const target = db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!target) throw new Error('User not found');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(value), target.id);
    return true;
  });

  // ---- Settings ----------------------------------------------------------
  guard(ipcMain, 'pos:settings:getAll', { auth: true }, () => ctx.getAllSettings(db));

  guard(ipcMain, 'pos:settings:set', { admin: true }, (_c, key, value) => {
    ctx.setSetting(db, key, value);
    return true;
  });

  // Register the remaining modules.
  require('./catalog').register(ipcMain, { ...ctx, guard });
  require('./sales').register(ipcMain, { ...ctx, guard });
  require('./integrations').register(ipcMain, { ...ctx, guard });

  const { shell } = require('electron');
  ipcMain.handle('pos:openExternal', async (_e, url) => {
    try {
      if (typeof url !== 'string' || !/^https:\/\/.+/i.test(url)) {
        return { ok: false, error: 'Invalid URL' };
      }
      await shell.openExternal(url);
      return { ok: true, data: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  backendReady = true;
  const win = ctx.getMainWindow && ctx.getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('pos:app:ready');
}

module.exports = { registerAll, makeGuard };
