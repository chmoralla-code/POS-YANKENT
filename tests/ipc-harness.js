'use strict';
/* Test harness: register all IPC handlers against a fake ipcMain and expose
 * a call(channel, session, ...args) that mimics the preload bridge (unwraps the
 * { ok, data } envelope and throws on error, exactly like the renderer sees). */
const { freshDb } = require('./dbutil');
const { getSession, requireRole } = require('../src/main/lib/auth');
const { getSetting, setSetting, getAllSettings } = require('../src/main/db');

function fakeIpc() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    _get(channel) { return handlers.get(channel); },
  };
}

async function makeApi() {
  const { db, close } = await freshDb();
  const ipc = fakeIpc();
  const ctx = {
    db,
    getSession,
    requireRole,
    getSetting,
    setSetting,
    getAllSettings,
    // stubs not needed for these tests but referenced by integrations.js
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
    BrowserWindow: function () { return { loadFile: async () => {}, close: () => {}, webContents: { print: async () => {} } }; },
    app: { getVersion: () => '0.0.0', isPackaged: false, getPath: () => '' },
  };
  const { registerAll } = require('../src/main/ipc/index');
  registerAll(ipc, ctx);

  // call(channel, session, ...args) -> data (throws Error on failure)
  async function call(channel, session, ...args) {
    const fn = ipc._get(channel);
    if (!fn) throw new Error('No handler for ' + channel);
    const res = await fn({}, session?.token || null, ...args);
    if (res && res.ok) return res.data;
    const err = new Error((res && res.error) || 'Request failed');
    err.code = res && res.code;
    throw err;
  }
  return { db, close, call, _handler: (channel) => ipc._get(channel) };
}

module.exports = { makeApi };