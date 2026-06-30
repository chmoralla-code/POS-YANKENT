'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { openDatabase, ensureSettings, getSetting, setSetting, getAllSettings } = require('./db');
const { seedDatabase } = require('./db/seed');
const { getSession, requireRole, logout } = require('./lib/auth');
const { registerAll } = require('./ipc');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// Secure, privileged scheme so the renderer is a secure context — required
// for Web Bluetooth (navigator.bluetooth) to pair a thermal printer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'yankent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let db;
let mainWindow;

function dbPath() {
  if (process.env.YANKENT_DB) return process.env.YANKENT_DB;
  if (app.isPackaged) return path.join(app.getPath('userData'), 'yankent.sqlite');
  return path.join(__dirname, '..', '..', 'data', 'yankent.sqlite');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0e0e0e',
    title: 'YANKENT POS',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'softwarelogo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL('yankent://app/index.html');
  mainWindow.setMenuBarVisibility(false);

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerProtocol() {
  protocol.handle('yankent', (request) => {
    const u = new URL(request.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(RENDERER_DIR, rel));
    if (!filePath.startsWith(RENDERER_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch('file:///' + filePath.replace(/\\/g, '/').replace(/^\//, ''));
  });
}

app.whenReady().then(async () => {
  // Database
  db = await openDatabase(dbPath());
  ensureSettings(db);
  seedDatabase(db);

  registerProtocol();
  createWindow();

  // IPC
  const ctx = {
    db,
    getSession,
    requireRole,
    getSetting,
    setSetting,
    getAllSettings,
    dialog,
    BrowserWindow,
    app,
    getMainWindow: () => mainWindow,
  };
  registerAll(ipcMain, ctx);

  // Smoke test: boot, wait for the window to load, then quit.
  if (process.env.YANKENT_SMOKE) {
    const seq = `(async () => {
      const log = (m) => console.log('[smoke] ' + m);
      try {
        log('bluetooth=' + (navigator.bluetooth ? 'ok' : 'none'));
        const u = await window.pos.login('admin','admin123');
        log('login ' + u.user.username + '/' + u.user.role);
        await window.pos.settings.getAll();
        const cats = await window.pos.categories.list(); log('categories=' + cats.length);
        const prods = await window.pos.products.list({includeServices:true}); log('products=' + prods.length);
        const cement = prods.find(p=>p.sku==='CMT-001');
        const cut = prods.find(p=>p.sku==='SVC-CUT');
        const sale = await window.pos.sales.create({
          items:[
            {productId:cement.id,sku:cement.sku,name:cement.name,unit:'bag',qty:2,unitPrice:280,factor:1,lineType:'product'},
            {productId:cut.id,sku:cut.sku,name:cut.name,unit:cut.units[0].unit,qty:3,unitPrice:cut.units[0].price,factor:1,isService:true,lineType:'service'}
          ],
          customerId:null, customerName:'Walk-in Customer', paymentMethod:'cash', amountTendered:1000
        });
        log('sale ' + sale.txnId + ' total=' + sale.receipt.total + ' change=' + sale.receipt.change);
        const enc = await window.pos.printer.encodeReceipt(sale.txnId);
        log('receipt bytes=' + enc.bytesBase64.length + ' text=' + enc.text.length);
        const sum = await window.pos.reports.summary();
        log('today=' + sum.today.total + '/' + sum.today.tx + ' best=' + (sum.bestDay ? sum.bestDay.label : 'none'));
        const best = await window.pos.reports.bestSelling({});
        log('bestSelling rows=' + best.length);
        const np = await window.pos.products.create({ name:'Smoke Test Item', base_unit:'pc', stock:5, price:50, units:[{unit:'pc',factor:1,price:50}] });
        log('created product id=' + np.id);
        const tg = await window.pos.telegram.sendReport();
        log('telegram: ' + (tg.ok ? 'sent' : tg.error));
        log('SMOKE OK');
      } catch (e) { log('SMOKE FAIL: ' + (e && e.message)); }
    })();`;
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(seq).catch((e) => console.log('[smoke] exec error', e.message));
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => console.log('[renderer]', message));
    mainWindow.webContents.on('render-process-gone', (_e, d) => console.log('[smoke] render gone', d.reason));
    setTimeout(() => app.quit(), 15000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (db) { try { db.close(); } catch {} }
});
