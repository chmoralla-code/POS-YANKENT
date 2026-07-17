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

const updateSubscriptions = new Map();
let nextUpdateSubscriptionId = 1;

function subscribeUpdate(channel, callback) {
  const id = nextUpdateSubscriptionId++;
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  updateSubscriptions.set(id, { channel, listener });
  return id;
}

function unsubscribeUpdate(id) {
  const subscription = updateSubscriptions.get(id);
  if (!subscription) return false;
  ipcRenderer.removeListener(subscription.channel, subscription.listener);
  updateSubscriptions.delete(id);
  return true;
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
  loans: {
    summary: (filters) => call('pos:loans:summary', filters || {}),
    listCustomers: (filters) => call('pos:loans:listCustomers', filters || {}),
    getCustomer: (id) => call('pos:loans:getCustomer', id),
    get: (id) => call('pos:loans:get', id),
    createCustomer: (profile) => call('pos:loans:createCustomer', profile),
    updateCustomer: (id, profile) => call('pos:loans:updateCustomer', id, profile),
    setCustomerActive: (id, active) => call('pos:loans:setCustomerActive', id, active),
    recordPayment: (id, payment) => call('pos:loans:recordPayment', id, payment),
    setDueDate: (id, dueDate, reason) => call('pos:loans:setDueDate', id, dueDate, reason),
    adjustBalance: (id, delta, reason) => call('pos:loans:adjustBalance', id, delta, reason),
    reversePayment: (id, reason) => call('pos:loans:reversePayment', id, reason),
    reminderStatus: () => call('pos:loans:reminderStatus'),
    runReminders: () => call('pos:loans:runReminders'),
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
    verifyAdmin: (pin, txnId) => call('pos:refunds:verifyAdmin', pin, txnId),
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
    state: () => call('pos:update:state'),
    check: () => { const r = ipcRenderer.invoke('pos:update:check'); return r.then((x) => x.ok ? x.data : (() => { throw new Error(x.error); })()); },
    download: () => call('pos:update:download'),
    install: () => call('pos:update:install'),
    onUpdateAvailable: (cb) => subscribeUpdate('pos:update:available', cb),
    onDownloadProgress: (cb) => subscribeUpdate('pos:update:download-progress', cb),
    onDownloaded: (cb) => subscribeUpdate('pos:update:downloaded', cb),
    onError: (cb) => subscribeUpdate('pos:update:error', cb),
    onState: (cb) => subscribeUpdate('pos:update:state', cb),
    off: (id) => unsubscribeUpdate(id),
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
    printReceiptRaw: (txn) => call('pos:printer:printReceiptRaw', txn),
    installDriver: () => call('pos:printer:installDriver'),
    checkStatus: () => { const r = ipcRenderer.invoke('pos:printer:checkStatus'); return r.then((x) => x.ok ? x.data : { driverAvailable: false, installedPrinters: [], printerConnected: false, status: 'offline', ready: false, canAutoRecover: false }); },
    setupFromLogin: () => { const r = ipcRenderer.invoke('pos:printer:setupFromLogin'); return r.then((x) => x.ok ? x.data : (() => { throw new Error(x.error || 'Setup failed'); })()); },
    // List installed Windows printer names (for the startup-test dropdown).
    listWindowsPrinters: () => { const r = ipcRenderer.invoke('pos:printer:listWindowsPrinters'); return r.then((x) => x.ok ? x.data : []); },
    // Queue/port/connection details and the printer YANKENT will route to.
    windowsStatus: () => { const r = ipcRenderer.invoke('pos:printer:windowsStatus'); return r.then((x) => x.ok ? x.data : { configured: '', printers: [], selected: null, autoSelected: false, code: 'error', status: 'offline', ready: false, canAutoRecover: false, error: x.error || 'Printer discovery failed', message: x.error || 'Printer discovery failed' }); },
    // Safe public recovery: no printer name is accepted; main chooses only one unambiguous connected thermal queue.
    autoRecover: () => { const r = ipcRenderer.invoke('pos:printer:autoRecover'); return r.then((x) => x.ok ? x.data : (() => { throw new Error(x.error || 'Printer recovery failed'); })()); },
    // Manually trigger the startup test print to the configured Windows printer.
    startupTest: () => call('pos:printer:startupTest'),
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

  // ---- Power events (wake/resume after sleep or power cycle) ----
  // Fires when the laptop wakes from sleep, hibernation, or is powered
  // back on.  The renderer uses this to proactively reconnect the thermal
  // printer before the next sale fails to print.
  onPowerResume: (cb) => ipcRenderer.on('pos:power:resume', (_e, reason) => cb(reason)),

  // ---- Startup test-print status (login printer status bar) ----
  // Fired by the main process while the startup auto test-print is running
  // so the login page can show "Testing print..." instead of "Printer
  // connected".  data = { state: 'testing'|'done'|'skipped'|'error', ... }
  onPrinterTestStatus: (cb) => ipcRenderer.on('pos:printer:startupTestStatus', (_e, data) => cb(data)),
  getPrinterTestStatus: () => { const r = ipcRenderer.invoke('pos:printer:getStartupTestStatus'); return r.then((x) => x.ok ? x.data : { state: null }); },

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
