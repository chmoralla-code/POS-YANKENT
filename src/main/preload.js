'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let token = null;

/**
 * Secure bridge between the renderer (UI) and the main process (local DB).
 * Every protected call auto-injects the session token and unwraps the
 * { ok, data } envelope, throwing on errors.
 */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, token, ...args);
  if (r && r.ok) return r.data;
  const err = new Error((r && r.error) || 'Request failed');
  err.code = r && r.code;
  throw err;
}

contextBridge.exposeInMainWorld('pos', {
  // ---- Auth ----
  async login(username, password) {
    const r = await ipcRenderer.invoke('pos:auth:login', { username, password });
    if (r && r.ok) { token = r.data.token; return r.data; }
    const err = new Error((r && r.error) || 'Login failed');
    err.code = r && r.code;
    throw err;
  },
  async logout() { await ipcRenderer.invoke('pos:auth:logout', token); token = null; },
  session: () => call('pos:auth:session'),

  // ---- Catalog ----
  categories: { list: () => call('pos:categories:list') },
  customers: {
    list: () => call('pos:customers:list'),
    create: (c) => call('pos:customers:create', c),
    update: (id, c) => call('pos:customers:update', id, c),
  },
  products: {
    list: (f) => call('pos:products:list', f || {}),
    get: (id) => call('pos:products:get', id),
    create: (p) => call('pos:products:create', p),
    update: (id, p) => call('pos:products:update', id, p),
    setStock: (id, stock, reason) => call('pos:products:setStock', id, stock, reason),
    delete: (id) => call('pos:products:delete', id),
    movements: (id) => call('pos:products:movements', id),
  },

  // ---- Sales ----
  sales: {
    create: (p) => call('pos:sales:create', p),
    list: (f) => call('pos:sales:list', f || {}),
    recent: (n) => call('pos:sales:recent', n),
    get: (txn) => call('pos:sales:get', txn),
    receipt: (txn) => call('pos:sales:receipt', txn),
  },

  // ---- Users ----
  users: {
    list: () => call('pos:users:list'),
    create: (u) => call('pos:users:create', u),
    update: (id, u) => call('pos:users:update', id, u),
    setPassword: (id, pw) => call('pos:users:setPassword', id, pw),
  },

  // ---- Settings ----
  settings: {
    getAll: () => call('pos:settings:getAll'),
    set: (k, v) => call('pos:settings:set', k, v),
  },

  // ---- Reports ----
  reports: {
    summary: () => call('pos:reports:summary'),
    bestSelling: (f) => call('pos:reports:bestSelling', f || {}),
    byCashier: (f) => call('pos:reports:byCashier', f || {}),
    salesByDay: (f) => call('pos:reports:salesByDay', f || {}),
    exportCSV: (type, f) => call('pos:reports:exportCSV', type, f || {}),
  },

  // ---- Printer (encoding in main; Bluetooth GATT in renderer) ----
  printer: {
    encodeReceipt: (txn) => call('pos:printer:encodeReceipt', txn),
    testPrint: () => call('pos:printer:testPrint'),
    printHtml: (html) => call('pos:printer:printHtml', html),
  },

  // ---- Telegram ----
  telegram: {
    isOnline: () => call('pos:telegram:isOnline'),
    test: () => call('pos:telegram:test'),
    sendReport: () => call('pos:telegram:sendReport'),
  },

  // ---- Backup ----
  backup: {
    export: () => call('pos:backup:export'),
    import: (f) => call('pos:backup:import', f),
  },
});
