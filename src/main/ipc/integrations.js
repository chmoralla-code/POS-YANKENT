'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildReceipt, receiptPlainText } = require('../lib/receipt');
const { encodeReceipt, testPrint } = require('../lib/escpos');
const { checkOnline, sendMessage, sendDocument, buildReportMessage } = require('../lib/telegram');
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

  // Print raw text directly to the Windows default thermal printer.
  // Uses the RawPrinterHelper .NET API to send text in RAW mode so the
  // printer driver receives exact monospaced 32-char lines without any
  // spooler reformatting, wrapping, or font substitution.
  guard(ipcMain, 'pos:printer:printHtml', { auth: true }, async (_c, html) => {
    // Extract plain text from the HTML body.
    // NOTE: do NOT .trim() or collapse leading/trailing newlines — receipts
    // rely on blank-line padding (3 lines above the store name, 8 below the
    // footer) so the paper feeds past the cutter.  We only collapse runs of
    // 4+ blank lines in the MIDDLE of the text down to 2 to avoid huge gaps
    // from HTML <br> soup in report printouts.
    const text = String(html)
      .replace(/<!doctype[^>]*>/i, '')
      .replace(/<\/?html[^>]*>/gi, '')
      .replace(/<\/?head[^>]*>.*?<\/head>/gis, '')
      .replace(/<\/?body[^>]*>/gi, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\r\n/g, '\n');
    // NOTE: we deliberately do NOT collapse runs of blank lines or trim
    // leading/trailing whitespace — the receipt plain-text relies on
    // leading feed (3 blank lines) and trailing feed (8 blank lines)
    // so the footer clears the cutter.  Collapsing would jam the footer
    // inside the printer mechanism.

    // Write text to a temp file and send it to the default printer in
    // RAW mode using a PowerShell snippet that invokes the .NET
    // winspool API. This sends bytes directly to the printer spooler
    // bypassing any GDI/font reformatting — the POS-58 receives the
    // exact 32-char monospaced text.
    const tmp = path.join(os.tmpdir(), `yankent-receipt-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      const escTmp = tmp.replace(/\\/g, '\\\\');
      const psScript = [
        'Add-Type -MemberDefinition @"',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr pd);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool ClosePrinter(IntPtr h);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool StartDocPrinter(IntPtr h, int l, ref DI di);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool EndDocPrinter(IntPtr h);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool StartPagePrinter(IntPtr h);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool EndPagePrinter(IntPtr h);',
        '[DllImport("winspool.drv", CharSet = CharSet.Auto)]',
        'public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);',
        '[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]',
        'public struct DI { public string n; public string o; public string t; }',
        '"@ -Name PU -Namespace W',
        '$prn = (Get-CimInstance -ClassName Win32_Printer -Filter "Default=true").Name',
        '[IntPtr]$h = 0',
        '$di = New-Object W.PU+DI',
        '$di.n = "YANKENT Receipt"',
        '$di.t = "RAW"',
        '[void][W.PU]::OpenPrinter($prn, [ref]$h, [IntPtr]::Zero)',
        '[void][W.PU]::StartDocPrinter($h, 1, [ref]$di)',
        '[void][W.PU]::StartPagePrinter($h)',
        '$bytes = [System.IO.File]::ReadAllBytes("' + escTmp + '")',
        '$w = 0',
        '[void][W.PU]::WritePrinter($h, $bytes, $bytes.Length, [ref]$w)',
        '[void][W.PU]::EndPagePrinter($h)',
        '[void][W.PU]::EndDocPrinter($h)',
        '[void][W.PU]::ClosePrinter($h)',
      ].join('\n');
      await new Promise((resolve) => {
        const child = spawn('powershell', [
          '-NoProfile', '-Command', psScript
        ], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => resolve());
        child.on('exit', () => resolve());
        setTimeout(() => resolve(), 15000);
      });
    } catch {
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  });

  // ---- Printer driver installer (bundled .exe, launched elevated) -------
  // Public (no app login required): printer setup is a one-time OS task that
  // may be done from the login screen before the cashier signs in. The real
  // gate is the Windows UAC prompt triggered by Start-Process -Verb RunAs.
  ipcMain.handle('pos:printer:installDriver', async () => {
    try {
      const exe = ctx.app.isPackaged
        ? path.join(process.resourcesPath, 'PrinterDriver.exe')
        : path.join(__dirname, '..', '..', '..', 'resources', 'PrinterDriver.exe');
      if (!fs.existsSync(exe)) return { ok: false, error: 'Installer not found at ' + exe };
      const child = spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -Verb RunAs`], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      child.on('error', (e) => console.error('[printer] spawn error:', e.message));
      return { ok: true, data: { launched: true, path: exe } };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ---- Printer driver check (public — works on login screen) ------------
  // Returns whether the PrinterDriver.exe is available (either in the user's
  // Downloads folder — placed there by the installer — or bundled with the
  // app) and a list of installed Windows printers so the login screen can
  // show a "Printer connected" / "Printer not connected" status.
  ipcMain.handle('pos:printer:checkStatus', async () => {
    try {
      // Look for PrinterDriver.exe in Downloads, then fall back to the
      // bundled copy in resources (dev mode) / process.resourcesPath (packaged).
      const downloadsExe = path.join(os.homedir(), 'Downloads', 'PrinterDriver.exe');
      const bundledExe = ctx.app.isPackaged
        ? path.join(process.resourcesPath, 'PrinterDriver.exe')
        : path.join(__dirname, '..', '..', '..', 'resources', 'PrinterDriver.exe');
      const driverPath = fs.existsSync(downloadsExe) ? downloadsExe : (fs.existsSync(bundledExe) ? bundledExe : null);

      // List installed Windows printers via PowerShell.
      let printers = [];
      try {
        const out = require('child_process').execSync(
          'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        printers = out.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {}

      // Heuristic: a thermal printer is "connected" if any installed printer
      // name contains common thermal brand keywords.
      const thermalKeywords = /thermal|receipt|58mm|80mm|pos|esc.?pos|xprinter|gprinter|zjiang/i;
      const thermalConnected = printers.some((p) => thermalKeywords.test(p));

      return {
        ok: true,
        data: {
          driverAvailable: !!driverPath,
          driverPath,
          installedPrinters: printers,
          // Only report "connected" when a thermal-style printer is actually
          // installed — not for any random A4 inkjet.  Otherwise the login
          // screen shows a false "Printer connected" indicator.
          printerConnected: thermalConnected,
        },
      };
    } catch (e) {
      return { ok: true, data: { driverAvailable: false, installedPrinters: [], printerConnected: false } };
    }
  });

  // Launch the PrinterDriver.exe from Downloads (or bundled) — non-elevated
  // so no UAC prompt; the driver installer handles its own elevation if needed.
  ipcMain.handle('pos:printer:setupFromLogin', async () => {
    try {
      const downloadsExe = path.join(os.homedir(), 'Downloads', 'PrinterDriver.exe');
      const bundledExe = ctx.app.isPackaged
        ? path.join(process.resourcesPath, 'PrinterDriver.exe')
        : path.join(__dirname, '..', '..', '..', 'resources', 'PrinterDriver.exe');
      const exe = fs.existsSync(downloadsExe) ? downloadsExe : (fs.existsSync(bundledExe) ? bundledExe : null);
      if (!exe) return { ok: false, error: 'PrinterDriver.exe not found in Downloads or app folder.' };
      const child = spawn('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -Verb RunAs`], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      child.on('error', (e) => console.error('[printer] setup launch error:', e.message));
      return { ok: true, data: { launched: true, path: exe } };
    } catch (e) { return { ok: false, error: e.message }; }
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
    const msgRes = await sendMessage(token, chatId, text);
    if (!msgRes.ok) {
      // Token rejected by Telegram ("Unauthorized") is the most common cause
      // of a silent failure. Surface a clearer message so the operator knows
      // to regenerate the bot token via BotFather rather than just "Failed".
      const err = msgRes.error || 'Telegram error';
      const hint = /unauthorized/i.test(err)
        ? 'Unauthorized — the bot token is invalid or revoked. Regenerate it in Telegram via @BotFather → /token, then update Settings → Integrations.'
        : err;
      return { ok: false, error: hint };
    }
    // Attach the latest data backup alongside the report.
    try {
      const data = exportAll(db);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `yankent-backup-${stamp}.yankent`;
      const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      const docRes = await sendDocument(token, chatId, filename, buffer, 'YANKENT POS data backup');
      if (!docRes.ok) return { ok: true, warning: 'Report sent, but backup file upload failed: ' + (docRes.error || 'unknown') };
    } catch (e) {
      return { ok: true, warning: 'Report sent, but backup file failed: ' + e.message };
    }
    return { ok: true };
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

  // ---- Auto-update (electron-updater via GitHub Releases) ----------------
  const updater = require('../updater');

  // Public: get current version
  ipcMain.handle('pos:update:getVersion', () => {
    return ctx.app.getVersion();
  });

  // Public: check for updates via GitHub Releases
  ipcMain.handle('pos:update:check', async () => {
    try {
      const result = await updater.checkForUpdates();
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Public: start downloading the update (available pre-login too)
  ipcMain.handle('pos:update:download', async () => {
    updater.downloadUpdate();
    return { ok: true, data: true };
  });

  // Public: install the downloaded update (available pre-login too)
  ipcMain.handle('pos:update:install', async () => {
    updater.installUpdate();
    return { ok: true, data: true };
  });
}

module.exports = { register };
