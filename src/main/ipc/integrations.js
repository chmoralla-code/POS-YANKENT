'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, exec } = require('child_process');
const { buildReceipt, receiptPlainText } = require('../lib/receipt');
const { encodeReceipt, testPrint } = require('../lib/escpos');
const { checkOnline, sendMessage, buildReportMessage } = require('../lib/telegram');
const { exportAll, importAll } = require('../backup');

function register(ipcMain, ctx) {
  const { db, guard } = ctx;

  // ---- Thermal printer (main-side encoding + system print fallback) ------
  guard(ipcMain, 'pos:printer:encodeReceipt', { auth: true }, (_c, txnId) => {
    const sale = db.prepare('SELECT id FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) return null;
    const receipt = buildReceipt(db, sale.id);
    const width = Number(ctx.getSetting(db, 'receipt_width') || 32);
    const bytes = encodeReceipt(receipt, width);
    return { bytesBase64: bytes.toString('base64'), text: receiptPlainText(receipt, width), width };
  });

  guard(ipcMain, 'pos:printer:testPrint', { auth: true }, () => {
    const width = Number(ctx.getSetting(db, 'receipt_width') || 32);
    const bytes = testPrint(width);
    return { bytesBase64: bytes.toString('base64'), width };
  });

  guard(ipcMain, 'pos:printer:printHtml', { auth: true }, async (_c, html) => {
    const tmp = path.join(os.tmpdir(), `yankent-receipt-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const win = new ctx.BrowserWindow({ show: false, width: 380, height: 600 });
    await win.loadFile(tmp);
    await new Promise((resolve) => {
      win.webContents.print({ silent: false, printBackground: true }, () => resolve());
    });
    win.close();
    try { fs.unlinkSync(tmp); } catch {}
    return true;
  });

  // ---- Telegram (offline-safe) ------------------------------------------
  // isOnline is public (no auth) so the login screen can show real status.
  ipcMain.handle('pos:telegram:isOnline', async () => {
    try { return { ok: true, data: await checkOnline() }; }
    catch { return { ok: true, data: false }; }
  });

  guard(ipcMain, 'pos:telegram:test', { admin: true }, async () => {
    const token = ctx.getSetting(db, 'telegram_token');
    const chatId = ctx.getSetting(db, 'telegram_chat_id');
    if (!token || !chatId) return { ok: false, error: 'Set token and chat ID first' };
    const online = await checkOnline();
    if (!online) return { ok: false, error: 'No internet connection' };
    return sendMessage(token, chatId, 'YANKENT POS — Telegram test message ✓');
  });

  // Any logged-in user (incl. cashier) can send the owner report.
  guard(ipcMain, 'pos:telegram:sendReport', { auth: true }, async () => {
    const token = ctx.getSetting(db, 'telegram_token');
    const chatId = ctx.getSetting(db, 'telegram_chat_id');
    if (!token || !chatId) return { ok: false, error: 'Telegram not configured' };
    const online = await checkOnline();
    if (!online) return { ok: false, error: 'Offline — report skipped (no data lost)' };
    const text = buildReportMessage(db);
    return sendMessage(token, chatId, text);
  });

  // ---- Backup & import (admin) ------------------------------------------
  guard(ipcMain, 'pos:backup:export', { admin: true }, async () => {
    const res = await ctx.dialog.showSaveDialog(ctx.getMainWindow(), {
      title: 'Backup YANKENT POS Data',
      defaultPath: `yankent-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.yankent`,
      filters: [{ name: 'YANKENT Backup', extensions: ['yankent', 'json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const data = exportAll(db);
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { path: res.filePath, tables: Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length])) };
  });

  guard(ipcMain, 'pos:backup:import', { admin: true }, async (_c, filePath) => {
    // If no path given, ask the user.
    let file = filePath;
    if (!file) {
      const res = await ctx.dialog.showOpenDialog(ctx.getMainWindow(), {
        title: 'Import YANKENT POS Backup',
        properties: ['openFile'],
        filters: [{ name: 'YANKENT Backup', extensions: ['yankent', 'json'] }],
      });
      if (res.canceled || !res.filePaths.length) return null;
      file = res.filePaths[0];
    }
    const raw = fs.readFileSync(file, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Backup file is not valid JSON'); }
    importAll(db, data);
    const counts = {};
    for (const t of ['users','categories','products','product_units','customers','sales','sale_items','stock_movements','settings']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    }
    return { path: file, tables: counts };
  });

  // ---- Check for updates (pull latest from GitHub) ----------------------
  // Public handler: return the current version only (fast, no network).
  ipcMain.handle('pos:update:getVersion', () => {
    return ctx.getSetting(db, 'app_version') || '1';
  });
  // Public (no auth) so it can be checked from Settings and Login.
  ipcMain.handle('pos:update:check', async () => {
    try {
      const currentVer = ctx.getSetting(db, 'app_version') || '1';
      const appDir = path.join(__dirname, '..', '..');
      execSync('git fetch origin main', { cwd: appDir, timeout: 30000, stdio: 'pipe' });
      const local = execSync('git rev-parse HEAD', { cwd: appDir, stdio: 'pipe' }).toString().trim();
      const remote = execSync('git rev-parse origin/main', { cwd: appDir, stdio: 'pipe' }).toString().trim();
      if (local === remote) return { ok: true, data: { upToDate: true, currentVer } };
      const ahead = execSync('git rev-list HEAD..origin/main --count', { cwd: appDir, stdio: 'pipe' }).toString().trim();
      const log = execSync('git log HEAD..origin/main --oneline', { cwd: appDir, stdio: 'pipe' }).toString().trim();
      return { ok: true, data: { upToDate: false, ahead, log, currentVer } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Apply update: git pull + bump version + restart app
  guard(ipcMain, 'pos:update:apply', { admin: true }, async () => {
    try {
      const appDir = path.join(__dirname, '..', '..');
      execSync('git pull origin main', { cwd: appDir, timeout: 60000, stdio: 'pipe' });
      // Bump minor version (1 → 1.1 → 1.2 → …)
      const ver = parseFloat(ctx.getSetting(db, 'app_version') || '1');
      const newVer = Math.round((ver + 0.1) * 10) / 10;
      ctx.setSetting(db, 'app_version', String(newVer));
      setTimeout(() => {
        ctx.app.relaunch();
        ctx.app.exit(0);
      }, 1500);
      return { ok: true, data: { restarting: true } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
