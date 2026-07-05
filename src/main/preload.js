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
  // Session expired — clear the token so subsequent calls fail fast and
  // the renderer can show the login screen instead of error toasts.
  if (r && r.code === 'SESSION_EXPIRED') {
    token = null;
  }
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
  async heartbeat() {
    const r = await ipcRenderer.invoke('pos:auth:heartbeat', token);
    return r && r.ok ? r.data : { alive: false };
  },
  async requestPasswordReset(username) {
    const r = await ipcRenderer.invoke('pos:auth:requestPasswordReset', username);
    if (r && r.ok) return r.data; throw new Error((r && r.error) || 'Request failed');
  },
  async checkResetApproval(t) {
    const r = await ipcRenderer.invoke('pos:auth:checkResetApproval', t);
    if (r && r.ok) return r.data; throw new Error((r && r.error) || 'Check failed');
  },
  async resetPassword(t, pw) {
    const r = await ipcRenderer.invoke('pos:auth:resetPassword', t, pw);
    if (r && r.ok) return r.data; throw new Error((r && r.error) || 'Reset failed');
  },

  // ---- Catalog ----
  categories: {
    list: () => call('pos:categories:list'),
    create: (name) => call('pos:categories:create', name),
    update: (id, name) => call('pos:categories:update', id, name),
    delete: (id) => call('pos:categories:delete', id),
    withCounts: () => call('pos:categories:withCounts'),
  },
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
    setStock: (id, stock, reason, date, location) => call('pos:products:setStock', id, stock, reason, date, location),
    delete: (id) => call('pos:products:delete', id),
    deleteAll: () => call('pos:products:deleteAll'),
    bulkImport: (items) => call('pos:products:bulkImport', items),
    movements: (id) => call('pos:products:movements', id),
  },

  // ---- Sales ----
  sales: {
    create: (p) => call('pos:sales:create', p),
    commit: (txn) => call('pos:sales:commit', txn),
    void: (txn) => call('pos:sales:void', txn),
    list: (f) => call('pos:sales:list', f || {}),
    recent: (n) => call('pos:sales:recent', n),
    get: (txn) => call('pos:sales:get', txn),
    receipt: (txn) => call('pos:sales:receipt', txn),
    reset: () => call('pos:sales:reset'),
  },

  refunds: {
    lookup: (txn) => call('pos:refunds:lookup', txn),
    verifyAdmin: (pin) => call('pos:refunds:verifyAdmin', pin),
    process: (p) => call('pos:refunds:process', p),
    list: (f) => call('pos:refunds:list', f || {}),
    summary: () => call('pos:refunds:summary'),
  },

  // ---- Users ----
  users: {
    list: () => call('pos:users:list'),
    create: (u) => call('pos:users:create', u),
    update: (id, u) => call('pos:users:update', id, u),
    delete: (id) => call('pos:users:delete', id),
    setPassword: (id, pw) => call('pos:users:setPassword', id, pw),
  },

  // ---- Settings ----
  settings: {
    getAll: () => call('pos:settings:getAll'),
    set: (k, v) => call('pos:settings:set', k, v),
  },

  // ---- Auto-update (electron-updater via GitHub Releases) ----------------
  update: {
    getVersion: () => ipcRenderer.invoke('pos:update:getVersion'),
    check: () => { const r = ipcRenderer.invoke('pos:update:check'); return r.then((x) => x.ok ? x.data : (() => { throw new Error(x.error); })()); },
    download: () => call('pos:update:download'),
    install: () => call('pos:update:install'),
    onUpdateAvailable: (cb) => ipcRenderer.on('pos:update:available', (_e, info) => cb(info)),
    onDownloadProgress: (cb) => ipcRenderer.on('pos:update:download-progress', (_e, p) => cb(p)),
    onDownloaded: (cb) => ipcRenderer.on('pos:update:downloaded', () => cb()),
    onError: (cb) => ipcRenderer.on('pos:update:error', (_e, msg) => cb(msg)),
  },

  // ---- Reports ----
  reports: {
    summary: () => call('pos:reports:summary'),
    bestSelling: (f) => call('pos:reports:bestSelling', f || {}),
    byCashier: (f) => call('pos:reports:byCashier', f || {}),
    salesByDay: (f) => call('pos:reports:salesByDay', f || {}),
    analytics: () => call('pos:reports:analytics'),
    exportCSV: (type, f) => call('pos:reports:exportCSV', type, f || {}),
  },

  // ---- Restock history (stock restock log) ----
  deliveries: {
    list: (f) => call('pos:reports:stockDeliveries', f || {}),
    summary: (f) => call('pos:reports:stockDeliverySummary', f || {}),
  },

  // ---- Printer (encoding in main; Bluetooth GATT in renderer) ----
  printer: {
    encodeReceipt: (txn) => call('pos:printer:encodeReceipt', txn),
    testPrint: () => call('pos:printer:testPrint'),
    printHtml: (html) => call('pos:printer:printHtml', html),
    installDriver: () => call('pos:printer:installDriver'),
    checkStatus: () => { const r = ipcRenderer.invoke('pos:printer:checkStatus'); return r.then((x) => x.ok ? x.data : { driverAvailable: false, installedPrinters: [], printerConnected: false }); },
    setupFromLogin: () => { const r = ipcRenderer.invoke('pos:printer:setupFromLogin'); return r.then((x) => x.ok ? x.data : (() => { throw new Error(x.error || 'Setup failed'); })()); },
  },

  // ---- Telegram ----
  telegram: {
    isOnline: () => call('pos:telegram:isOnline'),
    test: () => call('pos:telegram:test'),
    // sendReport returns { ok, warning?, error? } — the handler returns
    // { ok: false, error } on failure (offline, Telegram API error, HTML
    // parse error) rather than throwing, so we must unwrap the guard's
    // { ok:true, data:{ ok, error?, warning? } } envelope and return the
    // inner data.  Without this, callers checked the OUTER ok (always
    // true unless the handler threw) and showed "Report sent ✓" even
    // when nothing was delivered.
    async sendReport() {
      const r = await ipcRenderer.invoke('pos:telegram:sendReport', token);
      if (r && r.ok) return r.data || { ok: false, error: 'No response' };
      // Guard-level failure (handler threw) — rethrow so callers' catch
      // blocks surface the message, matching how call() behaves.
      const err = new Error((r && r.error) || 'No response');
      err.code = r && r.code;
      throw err;
    },
  },

  // ---- Backup ----
  backup: {
    export: () => call('pos:backup:export'),
    import: (f) => call('pos:backup:import', f),
  },

  // ---- Auto-startup (launch on Windows login) ----
  autostart: {
    get: () => { const r = ipcRenderer.invoke('pos:autostart:get'); return r.then((x) => x.ok ? x.data : { enabled: false }); },
    set: (enabled) => { const r = ipcRenderer.invoke('pos:autostart:set', enabled); return r.then((x) => x.ok ? x.data : { enabled: false }); },
  },

  // ---- External links (system browser) ---------------------------------
  async openExternal(url) {
    const r = await ipcRenderer.invoke('pos:openExternal', url);
    if (r && r.ok) return r.data;
    throw new Error((r && r.error) || 'Failed to open link');
  },

  waitForReady() {
    return new Promise((resolve) => {
      ipcRenderer.invoke('pos:app:isReady').then((r) => {
        if (r && r.ok && r.data) resolve();
        else ipcRenderer.once('pos:app:ready', () => resolve());
      }).catch(() => ipcRenderer.once('pos:app:ready', () => resolve()));
    });
  },
});
