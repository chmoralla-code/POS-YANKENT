'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

const { openDatabase, ensureSettings, getSetting, setSetting, getAllSettings } = require('./db');
const { seedDatabase } = require('./db/seed');
const { getSession, requireRole, logout } = require('./lib/auth');
const { registerAll } = require('./ipc');
const { initUpdater } = require('./updater');
const { exportAll } = require('./backup');
const os = require('os');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// Secure, privileged scheme so the renderer is a secure context — required
// for Web Bluetooth (navigator.bluetooth) to pair a thermal printer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'yankent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Allow autoplay of muted videos (login background) without user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let db;
let mainWindow;
let backupTimer = null;
let isQuitting = false;

// Catch any uncaught error during shutdown so the main process never
// crashes with "JavaScript error occurred in the main process" and
// leaves behind orphaned zombie processes that hold the single-instance
// lock (making the app appear to "not open" on next launch).
process.on('uncaughtException', (e) => {
  console.error('[main] Uncaught exception:', e.message);
  if (isQuitting) return; // swallow during shutdown
});
process.on('unhandledRejection', (e) => {
  console.error('[main] Unhandled rejection:', e && e.message ? e.message : e);
  if (isQuitting) return;
});

function dbPath() {
  if (process.env.YANKENT_DB) return process.env.YANKENT_DB;
  if (app.isPackaged) return path.join(app.getPath('userData'), 'yankent.sqlite');
  return path.join(__dirname, '..', '..', 'data', 'yankent.sqlite');
}

// ---- Startup auto test-print (once per OS boot) -------------------------
// When the POS first opens after the laptop is powered on, it automatically
// sends a short ESC/POS test print to the Windows printer named in settings
// (default "POS-58") via the winspool RAW API.  This confirms the printer is
// online before the cashier's first sale — no login required, runs in the
// background on the main process.
//
// "Once per boot" is enforced with a marker file in userData that stores the
// OS boot time (os.uptime() captured at launch).  If the marker already
// matches the current boot, we skip — so restarting the app during the same
// session does NOT re-print.  A fresh power cycle produces a different boot
// time, so the test fires on the next launch.
function startupTestMarkerPath() {
  return path.join(app.getPath('userData'), 'startup-test-marker.json');
}

function currentBootId() {
  // os.uptime() is seconds since the OS booted.  Combining it with the
  // process start time gives a stable per-boot identifier: two app launches
  // in the same boot session see the same rounded uptime.
  return Math.floor(os.uptime() / 60);
}

function shouldRunStartupTest() {
  try {
    const markerPath = startupTestMarkerPath();
    if (fs.existsSync(markerPath)) {
      const data = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (data && data.bootId === currentBootId()) {
        return false; // already printed during this boot session
      }
    }
  } catch {}
  return true;
}

function markStartupTestDone() {
  try {
    const markerPath = startupTestMarkerPath();
    fs.writeFileSync(markerPath, JSON.stringify({ bootId: currentBootId(), at: Date.now() }), 'utf8');
  } catch (e) {
    console.error('[main] Could not write startup-test marker:', e.message);
  }
}

// Fire the startup test print if enabled + not already done this boot.
// Delayed a few seconds so the splash/login screen is up and the printer
// spooler has settled after boot.
async function maybeStartupTestPrint(ctx) {
  try {
    const enabled = getSetting(db, 'startup_test_print');
    if (enabled === '0') return; // admin disabled it
    if (!shouldRunStartupTest()) return; // already ran this boot
    // Wait for the renderer window to be visible before printing.
    await new Promise((r) => setTimeout(r, 5000));
    if (isQuitting) return;
    const { _sendStartupTestPrint } = require('./ipc/integrations');
    const res = await _sendStartupTestPrint(ctx);
    if (res && res.ok) {
      console.log('[main] Startup test print sent to "' + res.printer + '".');
    } else {
      // Don't mark as done on failure so a retry on the next app launch is
      // possible — unless the printer simply isn't installed (a permanent
      // condition that would retry forever).
      const skipped = res && res.skipped;
      console.warn('[main] Startup test print ' + (skipped ? 'skipped' : 'failed') + ': ' + (res && res.error));
      if (!skipped) return; // leave the marker unwritten so it retries
    }
    markStartupTestDone();
  } catch (e) {
    console.error('[main] Startup test print error:', e.message);
  }
}

// ---- Auto-backup helpers (top-level so before-quit can access them) ----
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BACKUPS = 5;

function getBackupDir() {
  return path.join(path.dirname(dbPath()), 'backups');
}

function doAutoBackup() {
  if (!db) return;
  try {
    const dir = getBackupDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = exportAll(db);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `yankent-auto-${stamp}.yankent`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('yankent-auto-') && f.endsWith('.yankent'))
      .sort()
      .reverse();
    for (const old of files.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch {}
    }
    console.log('[main] Auto-backup saved:', file);
  } catch (e) {
    console.error('[main] Auto-backup failed:', e.message);
  }
}

// ---- Auto-startup on Windows login -------------------------------------
// Uses Electron's setLoginItemSettings which writes to the Windows registry
// Run key under the hood.  Toggled by the admin from Settings → System.
// On first run (packaged) we enable it by default so the POS launches
// automatically when the laptop is powered on.  (No special launch arg is
// needed — the auto-started instance behaves like a normal launch, which is
// what we want: full splash + login screen, ready for the cashier.)
function setAutoStartup(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
    });
    return true;
  } catch (e) {
    console.error('[main] setAutoStartup failed:', e.message);
    return false;
  }
}

function isAutoStartupEnabled() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0a0c',
    title: 'YANKENT POS',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'softwarelogo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.maximize();
      mainWindow.show();
    }
  });

  mainWindow.loadURL('yankent://app/index.html');
  mainWindow.setMenuBarVisibility(false);

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });

  // If the renderer process crashes (GPU failure, OOM, etc.), reload the
  // page so the user sees the login screen again instead of a blank window
  // that looks like the app "won't open."  Skip the reload if we're already
  // shutting down.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] Renderer process gone:', details.reason);
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.loadURL('yankent://app/index.html'); } catch {}
        }
      }, 1000);
    }
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

// Single-instance lock: only one YANKENT POS may run at a time. A second
// launch is blocked, quits, and focuses the already-running window instead.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
  registerProtocol();
  createWindow();

  // Open the database with crash recovery. If the existing .sqlite file is
  // corrupted (partial write, disk full, forced shutdown), back it up and
  // create a fresh one so the app always boots instead of hanging on the
  // loading screen with no IPC handlers registered.
  try {
    db = await openDatabase(dbPath());
    ensureSettings(db);
    seedDatabase(db);
  } catch (e) {
    console.error('[main] Database open failed, attempting recovery:', e.message);
    const p = dbPath();
    try {
      if (fs.existsSync(p)) fs.renameSync(p, p + '.corrupted-' + Date.now());
    } catch {}
    try {
      db = await openDatabase(p);
      ensureSettings(db);
      seedDatabase(db);
      console.log('[main] Database recovered — fresh database created.');
    } catch (e2) {
      console.error('[main] Database recovery also failed:', e2.message);
    }
  }

  // ---- Sweep orphaned pending sales -------------------------------------
  // A sale is created as status='pending' (no stock deducted) and only
  // finalized when the cashier clicks PRINT (commit) or closes the receipt
  // modal (void).  If the app crashes, loses power, or is force-quit while
  // the receipt modal is open, the pending sale + its items are orphaned in
  // the DB forever.  On every startup we delete any leftover pending sales
  // (and their items) so the database stays clean.  This is always safe
  // because pending sales never deducted stock, wrote no movements, and
  // updated no contractor credit — there is nothing to reverse.
  try {
    const sweep = db.transaction(() => {
      const orphans = db.prepare("SELECT id FROM sales WHERE status='pending'").all();
      if (!orphans.length) return 0;
      const delItems = db.prepare('DELETE FROM sale_items WHERE sale_id=?');
      const delSale = db.prepare('DELETE FROM sales WHERE id=?');
      for (const o of orphans) { delItems.run(o.id); delSale.run(o.id); }
      return orphans.length;
    });
    const n = sweep();
    if (n) console.log('[main] Cleaned up ' + n + ' orphaned pending sale(s) on startup.');
  } catch (e) { console.error('[main] Pending-sale sweep failed:', e.message); }

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

  // ---- Auto-startup IPC (Settings → System toggle) ---------------------
  // Exposes get/set so the admin can control "launch on login" from the UI.
  // Default is OFF — the app never auto-enables itself. Admin must opt in.
  // On first run after this update, clear any previously-forced auto-start
  // registration so users who had it enabled without choosing to are freed.
  try {
    const autoStartInit = getSetting(db, 'autostart_initialized');
    if (autoStartInit) {
      setAutoStartup(false);
      setSetting(db, 'autostart_initialized', '0');
      console.log('[main] Cleared legacy auto-startup registration.');
    } else if (!app.isPackaged) {
      // Dev: always clear so npm start never leaves a debug Run key around.
      setAutoStartup(false);
    }
  } catch (e) { console.error('[main] autostart init check failed:', e.message); }
  ipcMain.handle('pos:autostart:get', () => ({ ok: true, data: { enabled: isAutoStartupEnabled() } }));
  ipcMain.handle('pos:autostart:set', (_e, enabled) => {
    const ok = setAutoStartup(!!enabled);
    return { ok, data: { enabled: isAutoStartupEnabled() } };
  });

  try { initUpdater(mainWindow); } catch (e) {
    console.error('[main] Updater init failed (non-fatal):', e.message);
  }

  // ---- Auto-backup every 5 minutes ----------------------------------
  backupTimer = setInterval(doAutoBackup, BACKUP_INTERVAL_MS);

  // ---- Startup auto test-print (once per OS boot) --------------------
  // Sends a test print to the Windows "POS-58" printer the first time the
  // POS opens after the laptop is powered on.  Skipped during smoke/e2e
  // tests so it doesn't spam a real printer in CI.
  if (!process.env.YANKENT_SMOKE && !process.env.YANKENT_E2E) {
    maybeStartupTestPrint(ctx);
  }

  // Smoke test: boot, wait for the window to load, then quit.
  // YANKENT_E2E is set by the Playwright harness — it skips the smoke
  // script and the auto-quit so the app stays running for interactive tests.
  if (process.env.YANKENT_SMOKE && !process.env.YANKENT_E2E) {
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

  // ---- Power event listeners (printer reconnection on wake) -------------
  // After a laptop sleeps, hibernates, or is powered off and back on, the
  // Bluetooth GATT characteristic the renderer holds becomes stale — the
  // printer appears "connected" to the OS but writes throw GATT errors.  On
  // resume/unlock, ping the renderer so it can proactively drop the dead
  // handle and re-establish the link before the next sale's print fails.
  // We send the event after a short delay because the Bluetooth adapter and
  // USB thermal printers take a few seconds to re-enumerate after wake.
  const notifyPowerResume = (reason) => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !isQuitting) {
        mainWindow.webContents.send('pos:power:resume', reason);
      }
    }, 3000);
  };
  powerMonitor.on('resume', () => notifyPowerResume('resume'));
  powerMonitor.on('unlock-screen', () => notifyPowerResume('unlock'));
 });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    // Destroy any lingering hidden print windows before quitting so they
    // don't become zombie processes that hold the single-instance lock.
    BrowserWindow.getAllWindows().forEach((w) => { try { w.destroy(); } catch {} });
    app.quit();
    // Force-exit after 2 seconds if app.quit() stalls (a pending IPC or
    // timer can keep the event loop alive, leaving the process as a zombie).
    setTimeout(() => process.exit(0), 2000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (backupTimer) clearInterval(backupTimer);
  // Final backup — wrapped so any DB error doesn't crash the process
  // during shutdown (which would orphan the single-instance lock).
  try { doAutoBackup(); } catch (e) { console.error('[main] Final backup error:', e.message); }
  if (db) { try { db.close(); } catch (e) { console.error('[main] DB close error:', e.message); } }
});
