'use strict';

/**
 * IPC registration for the main process. Exposes a guarded bridge so the
 * renderer talks to the local SQLite DB through a small, validated API.
 *
 * Every protected channel receives the session token as its first argument
 * (prepended automatically by the preload bridge) and returns a uniform
 * { ok, data } | { ok:false, error, code } envelope.
 */

function makeGuard({ getSession, requireRole }) {
  return function guard(ipcMain, channel, opts, handler) {
    ipcMain.handle(channel, async (event, token, ...args) => {
      try {
        const session = getSession(token);
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
  const guard = makeGuard(ctx);
  const { db } = ctx;
  const { verifyPassword, createSession, logout, hashPassword } = require('../lib/auth');

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

  guard(ipcMain, 'pos:auth:session', { auth: true }, ({ session }) => {
    if (!session) return null;
    return { id: session.id, username: session.username, full_name: session.full_name, role: session.role };
  });

  // ---- Users (admin) -----------------------------------------------------
  guard(ipcMain, 'pos:users:list', { admin: true }, () => {
    return db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id').all();
  });

  guard(ipcMain, 'pos:users:create', { admin: true }, (_c, u) => {
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(u.username);
    if (exists) throw new Error('Username already exists');
    const info = db.prepare(
      'INSERT INTO users(username, password_hash, full_name, role, active) VALUES(?,?,?,?,1)'
    ).run(u.username, hashPassword(u.password), u.full_name, u.role);
    return { id: info.lastInsertRowid };
  });

  guard(ipcMain, 'pos:users:update', { admin: true }, (_c, id, u) => {
    db.prepare('UPDATE users SET full_name=?, role=?, active=? WHERE id=?')
      .run(u.full_name, u.role, u.active ? 1 : 0, id);
    return true;
  });

  guard(ipcMain, 'pos:users:setPassword', { admin: true }, (_c, id, password) => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
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
}

module.exports = { registerAll, makeGuard };
