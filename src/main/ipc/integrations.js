'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildReceipt, receiptPlainText } = require('../lib/receipt');
const { encodeReceipt, testPrint } = require('../lib/escpos');
const { checkOnline, sendMessage, sendDocument, buildReportMessage } = require('../lib/telegram');
const { exportAll, importAll } = require('../backup');

// ---- Windows printer helpers (winspool RAW mode via PowerShell) ---------
// These run a PowerShell snippet that P/Invokes winspool.drv to send bytes
// directly to a printer spooler in RAW mode, bypassing GDI/font substitution
// so a thermal POS-58 receives exact monospaced 32-char text.  Used by both
// the receipt system-print fallback and the startup auto test-print.

/**
 * Send the contents of a file to a Windows printer in RAW mode.
 * @param {string} filePath - absolute path to a file whose bytes will be sent
 * @param {string|null} printerName - printer name; null/undefined = Windows default printer
 * @returns {Promise<{ok:boolean, error?:string, printer?:string}>}
 */
function sendRawFileToPrinter(filePath, printerName) {
  return new Promise((resolve) => {
    const escTmp = filePath.replace(/\\/g, '\\\\');
    // If no printer name given, fall back to the Windows default printer.
    const printerExpr = printerName
      ? "'" + String(printerName).replace(/'/g, "''") + "'"
      : '((New-Object System.Drawing.Printing.PrinterSettings).PrinterName)';
    const psScript = [
      'Add-Type -AssemblyName System.Drawing',
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
      '$prn = ' + printerExpr,
      'if (-not $prn) { Write-Output "ERR:no_printer"; exit 2 }',
      '[IntPtr]$h = 0',
      '$di = New-Object W.PU+DI',
      '$di.n = "YANKENT Receipt"',
      '$di.t = "RAW"',
      '$opened = [W.PU]::OpenPrinter($prn, [ref]$h, [IntPtr]::Zero)',
      'if (-not $opened) { Write-Output "ERR:open_failed:" + $prn; exit 3 }',
      '[void][W.PU]::StartDocPrinter($h, 1, [ref]$di)',
      '[void][W.PU]::StartPagePrinter($h)',
      '$bytes = [System.IO.File]::ReadAllBytes("' + escTmp + '")',
      '$w = 0',
      '[void][W.PU]::WritePrinter($h, $bytes, $bytes.Length, [ref]$w)',
      '[void][W.PU]::EndPagePrinter($h)',
      '[void][W.PU]::EndDocPrinter($h)',
      '[void][W.PU]::ClosePrinter($h)',
      'Write-Output "OK:" + $prn',
    ].join('\n');
    let stdout = '';
    const child = spawn('powershell', ['-NoProfile', '-Command', psScript], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const done = (code) => {
      const out = stdout.trim();
      if (out.startsWith('OK:')) resolve({ ok: true, printer: out.slice(3) });
      else if (out.startsWith('ERR:')) resolve({ ok: false, error: out.slice(4), printer: printerName });
      else resolve({ ok: false, error: 'powershell exit ' + code });
    };
    child.on('error', () => resolve({ ok: false, error: 'spawn failed' }));
    child.on('exit', done);
    // Safety timeout so a hung spooler never blocks the event loop.
    setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 15000);
  });
}

/**
 * Windows printer queues are persistent: replacing a USB printer often leaves
 * the old queue behind and installs the replacement as "POS-58 (1)". Queue
 * status/offline flags are unreliable for these drivers, so each USB00x port
 * is mapped to its PnP device and checked through cfgmgr32.
 */
function listWindowsPrinterDetails() {
  return new Promise((resolve) => {
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class YankentUsbDeviceState {',
      '  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]',
      '  private static extern int CM_Locate_DevNodeW(out uint node, string id, uint flags);',
      '  [DllImport("cfgmgr32.dll")]',
      '  private static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);',
      '  public static bool IsConnected(string id) {',
      '    if (String.IsNullOrWhiteSpace(id)) return false;',
      '    uint node, status, problem;',
      '    return CM_Locate_DevNodeW(out node, id, 0) == 0',
      '      && CM_Get_DevNode_Status(out status, out problem, node, 0) == 0',
      '      && (status & 0x00000002) != 0;',
      '  }',
      '}',
      "'@",
      "$printerRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers'",
      "$portsRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports'",
      '$defaultPrinter = ""',
      'try {',
      '  Add-Type -AssemblyName System.Drawing -ErrorAction Stop',
      '  $defaultPrinter = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName',
      '} catch {}',
      '$items = @(Get-ChildItem -LiteralPath $printerRoot | ForEach-Object {',
      '  $p = Get-ItemProperty -LiteralPath $_.PSPath',
      '  $port = [string]$p.Port',
      '  $connected = $null',
      "  if ($port -match '^USB\\d+$') {",
      '    $deviceId = (Get-ItemProperty -LiteralPath (Join-Path $portsRoot $port) -Name "Device Id" -ErrorAction SilentlyContinue)."Device Id"',
      '    $connected = [YankentUsbDeviceState]::IsConnected([string]$deviceId)',
      '  }',
      '  [pscustomobject]@{',
      '    name = [string]$p.Name',
      '    port = $port',
      '    driver = [string]$p."Printer Driver"',
      '    connected = $connected',
      '    isDefault = ([string]$p.Name -ieq $defaultPrinter)',
      '  }',
      '})',
      '$json = ConvertTo-Json -InputObject $items -Compress -Depth 3',
      '[Console]::Out.Write($json)',
    ].join('\n');

    let out = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish([]);
      return;
    }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish([]));
    child.on('exit', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        finish(rows
          .filter((p) => p && p.name)
          .map((p) => ({
            name: String(p.name).trim(),
            port: String(p.port || '').trim(),
            driver: String(p.driver || '').trim(),
            connected: p.connected === true ? true : (p.connected === false ? false : null),
            isDefault: !!p.isDefault,
          }))
          .sort((a, b) => Number(b.connected === true) - Number(a.connected === true) || a.name.localeCompare(b.name)));
      } catch {
        finish([]);
      }
    });
    timer = setTimeout(() => { try { child.kill(); } catch {} finish([]); }, 7000);
  });
}

const THERMAL_PRINTER_RE = /thermal|receipt|58mm|80mm|(?:^|[\s_-])pos(?:[\s_-]|\d)|esc.?pos|xprinter|gprinter|zjiang/i;

function isThermalPrinter(printer) {
  return THERMAL_PRINTER_RE.test(String(printer && printer.name || '') + ' ' + String(printer && printer.driver || ''));
}

function printerFamilyName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+\(\d+\)$/, '');
}

/**
 * Keep the configured queue when it is usable. If Windows left that exact USB
 * queue behind after hardware replacement, select one unambiguous connected
 * sibling (same base name or thermal driver) instead.
 */
function resolveWindowsPrinter(printers, configuredName) {
  const list = (Array.isArray(printers) ? printers : [])
    .filter((p) => p && String(p.name || '').trim())
    .map((p) => ({
      name: String(p.name).trim(),
      port: String(p.port || '').trim(),
      driver: String(p.driver || '').trim(),
      connected: p.connected === true ? true : (p.connected === false ? false : null),
      isDefault: !!p.isDefault,
    }));
  const configured = String(configuredName || '').trim();
  const exact = list.find((p) => p.name.toLowerCase() === configured.toLowerCase());

  // For non-USB queues, null means installed/unknown and remains a valid exact
  // choice. Only a definitive USB disconnection triggers replacement.
  if (exact && exact.connected !== false) {
    return { selected: exact, autoSelected: false, code: 'configured' };
  }

  const connectedThermal = list.filter((p) => p.connected === true && isThermalPrinter(p));
  const family = printerFamilyName(configured);
  const familyMatches = connectedThermal.filter((p) => printerFamilyName(p.name) === family);
  const driverMatches = exact && exact.driver
    ? connectedThermal.filter((p) => p.driver.toLowerCase() === exact.driver.toLowerCase())
    : [];
  const replacements = familyMatches.length ? familyMatches : driverMatches;

  if (replacements.length === 1) {
    const selected = replacements[0];
    return {
      selected,
      autoSelected: true,
      code: exact ? 'replacement' : 'renamed',
      reason: 'Configured printer "' + (configured || '(none)') + '" is unavailable; using connected replacement "' + selected.name + '" on ' + (selected.port || 'its active port') + '.',
    };
  }

  // Never auto-route to a different model merely because it is the only
  // connected queue; a strong same-family match is still required.
  if ((!exact || exact.connected === false) && connectedThermal.length === 1 && printerFamilyName(connectedThermal[0].name) === family) {
    return {
      selected: connectedThermal[0],
      autoSelected: true,
      code: 'only-connected-thermal',
      reason: 'Using the only connected thermal printer "' + connectedThermal[0].name + '".',
    };
  }

  const installed = list.map((p) => p.name + (p.port ? ' (' + p.port + ')' : '')).join(', ') || '(none)';
  if (exact && exact.connected === false) {
    return {
      selected: null,
      autoSelected: false,
      code: 'disconnected',
      error: 'Printer "' + exact.name + '" is installed on ' + (exact.port || 'Windows') + ' but is not physically connected. Installed: ' + installed,
    };
  }
  return {
    selected: null,
    autoSelected: false,
    code: 'not-found',
    error: 'Printer "' + (configured || '(not configured)') + '" was not found. Installed: ' + installed,
  };
}

/**
 * Convert queue discovery into a stable, renderer-friendly health model.
 * This function is pure so recovery decisions can be regression tested
 * without touching the Windows spooler or a physical printer.
 */
function buildWindowsPrinterHealth(printers, configuredName) {
  const list = (Array.isArray(printers) ? printers : [])
    .filter((p) => p && String(p.name || '').trim())
    .map((p) => ({
      name: String(p.name).trim(),
      port: String(p.port || '').trim(),
      driver: String(p.driver || '').trim(),
      connected: p.connected === true ? true : (p.connected === false ? false : null),
      isDefault: !!p.isDefault,
    }));
  const configured = String(configuredName || '').trim();
  const resolution = resolveWindowsPrinter(list, configured);
  const connectedThermal = list.filter((p) => p.connected === true && isThermalPrinter(p));
  const staleThermal = list.filter((p) => p.connected === false && isThermalPrinter(p));
  const configuredPrinter = list.find((p) => p.name.toLowerCase() === configured.toLowerCase()) || null;

  let status = 'offline';
  if (resolution.selected && resolution.autoSelected) status = 'repair-available';
  else if (resolution.selected) status = 'ready';
  else if (connectedThermal.length > 1) status = 'needs-selection';

  const canAutoRecover = status === 'repair-available'
    && resolution.selected
    && resolution.selected.connected === true
    && isThermalPrinter(resolution.selected);
  const message = status === 'ready'
    ? 'Printer is ready.'
    : status === 'repair-available'
      ? (resolution.reason || 'A connected replacement printer was found.')
      : status === 'needs-selection'
        ? 'More than one thermal printer is connected. Choose one in Settings.'
        : (resolution.error || 'No connected thermal printer was found.');

  return {
    configured,
    printers: list,
    configuredPrinter,
    selected: resolution.selected,
    connectedThermalPrinters: connectedThermal,
    staleThermalPrinters: staleThermal,
    autoSelected: !!resolution.autoSelected,
    code: resolution.code,
    status,
    ready: status === 'ready',
    canAutoRecover,
    needsSelection: status === 'needs-selection',
    reason: resolution.reason || '',
    error: resolution.error || '',
    message,
  };
}

async function getWindowsPrinterHealth(ctx, listPrinters = listWindowsPrinterDetails) {
  const printers = await listPrinters();
  // Read settings after discovery so a slow, older request cannot repaint a
  // route that was repaired while Windows enumeration was still running.
  const configured = ctx.getSetting(ctx.db, 'startup_test_printer') || 'POS-58';
  const printerType = ctx.getSetting(ctx.db, 'printer_type') || 'bluetooth';
  const pairedBluetoothName = ctx.getSetting(ctx.db, 'printer_device_name') || '';
  const health = buildWindowsPrinterHealth(printers, configured);
  if (printerType === 'none') {
    return { ...health, printerType, pairedBluetoothName, status: 'disabled', ready: false, canAutoRecover: false, message: 'Printing is disabled in Settings.' };
  }
  if (printerType === 'bluetooth' && pairedBluetoothName) {
    return {
      ...health,
      printerType,
      pairedBluetoothName,
      status: 'bluetooth-configured',
      ready: false,
      canAutoRecover: false,
      message: 'A Bluetooth printer is configured. Use Printer Settings to change the route.',
    };
  }
  return { ...health, printerType, pairedBluetoothName };
}

async function autoRecoverWindowsPrinter(ctx, listPrinters = listWindowsPrinterDetails) {
  const health = await getWindowsPrinterHealth(ctx, listPrinters);
  if (!health.canAutoRecover || !health.selected) {
    return { ...health, repaired: false, previousPrinter: health.configured };
  }

  const previousPrinter = health.configured;
  const previousType = health.printerType || 'bluetooth';
  ctx.setSetting(ctx.db, 'startup_test_printer', health.selected.name);
  ctx.setSetting(ctx.db, 'printer_type', 'system');
  const after = buildWindowsPrinterHealth(health.printers, health.selected.name);
  return {
    ...after,
    printerType: 'system',
    pairedBluetoothName: health.pairedBluetoothName || '',
    repaired: previousPrinter.toLowerCase() !== health.selected.name.toLowerCase() || previousType !== 'system',
    previousPrinter,
    previousType,
    message: 'YANKENT switched from "' + previousPrinter + '" to "' + health.selected.name + '"' + (health.selected.port ? ' on ' + health.selected.port : '') + '.',
  };
}
async function listWindowsPrinters() {
  const printers = await listWindowsPrinterDetails();
  return printers.map((p) => p.name);
}

async function resolveConfiguredWindowsPrinter(ctx, persist = true) {
  const configured = ctx.getSetting(ctx.db, 'startup_test_printer') || 'POS-58';
  const printers = await listWindowsPrinterDetails();
  const resolution = resolveWindowsPrinter(printers, configured);
  if (persist && resolution.selected && resolution.autoSelected && typeof ctx.setSetting === 'function') {
    ctx.setSetting(ctx.db, 'startup_test_printer', resolution.selected.name);
    const type = ctx.getSetting(ctx.db, 'printer_type');
    const pairedBluetoothName = ctx.getSetting(ctx.db, 'printer_device_name');
    if (type === 'bluetooth' && !pairedBluetoothName) {
      ctx.setSetting(ctx.db, 'printer_type', 'system');
    }
  }
  return { configured, printers, ...resolution };
}

/**
 * Send a startup test print to a named Windows thermal printer.
 * Builds a short ESC/POS test-print buffer (or plain text), writes it to a
 * temp file, and sends it in RAW mode via winspool.  Returns whether the
 * printer was found and the spooler accepted the job.
 * @param {object} ctx - the app context (getSetting, db)
 * @returns {Promise<{ok:boolean, error?:string, printer?:string, skipped?:boolean}>}
 */
async function sendStartupTestPrint(ctx) {
  const width = Number(ctx.getSetting(ctx.db, 'receipt_width') || 32);
  const route = await resolveConfiguredWindowsPrinter(ctx);
  if (!route.selected) {
    return { ok: false, skipped: route.code === 'not-found', error: route.error };
  }
  const printerName = route.selected.name;
  // Build the test-print bytes (ESC/POS init + a few lines + cut) and write
  // them to a temp file.  We send the RAW ESC/POS bytes, not plain text, so
  // the POS-58 renders the store name centered and performs a clean cut.
  const { testPrint } = require('../lib/escpos');
  const bytes = testPrint(width);
  const tmp = path.join(os.tmpdir(), `yankent-startup-test-${Date.now()}.bin`);
  try {
    fs.writeFileSync(tmp, bytes);
    const res = await sendRawFileToPrinter(tmp, printerName);
    return { ...res, printer: printerName, autoSelected: route.autoSelected };
  } catch (e) {
    return { ok: false, error: e.message, printer: printerName };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Exported so main.js can call it on startup (no IPC round-trip needed).
// (The final module.exports line at the bottom of this file includes these.)

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

  // ---- Print a receipt directly to the named Windows thermal printer ------
  // This is the primary sale-receipt path for USB thermal printers (e.g. the
  // POS-58 connected over USB, not Bluetooth).  It encodes the receipt to
  // ESC/POS bytes in the main process and sends them in RAW mode to the
  // Windows printer named in settings (default "POS-58") via winspool — the
  // same path the startup auto test-print uses. If Windows retained a stale
  // queue after hardware replacement, the single connected sibling queue is
  // selected and saved automatically.
  guard(ipcMain, 'pos:printer:printReceiptRaw', { auth: true }, async (_c, txnId) => {
    const sale = db.prepare('SELECT id FROM sales WHERE txn_id=?').get(txnId);
    if (!sale) throw new Error('Sale not found: ' + txnId);
    const receipt = buildReceipt(db, sale.id);
    const width = Number(ctx.getSetting(db, 'receipt_width') || 32);
    const bytes = encodeReceipt(receipt, width);
    const route = await resolveConfiguredWindowsPrinter(ctx);
    if (!route.selected) throw new Error(route.error || 'No connected Windows printer');
    const printerName = route.selected.name;
    const tmp = path.join(os.tmpdir(), `yankent-receipt-${Date.now()}.bin`);
    try {
      fs.writeFileSync(tmp, bytes);
      const res = await sendRawFileToPrinter(tmp, printerName);
      if (!res.ok) throw new Error(res.error || ('Failed to print to ' + printerName));
      return { ok: true, printer: printerName, autoSelected: route.autoSelected };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  // Print raw text directly to the selected Windows thermal printer.
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

    // Reports and text fallbacks use the same selected Windows printer as
    // receipts; never silently redirect to a stale Windows default queue.
    const route = await resolveConfiguredWindowsPrinter(ctx);
    if (!route.selected) throw new Error(route.error || 'No connected Windows printer');
    const printerName = route.selected.name;
    const tmp = path.join(os.tmpdir(), `yankent-receipt-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      const res = await sendRawFileToPrinter(tmp, printerName);
      if (!res.ok) throw new Error(res.error || ('Failed to print to ' + printerName));
      return { printer: printerName, autoSelected: route.autoSelected };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
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

      const configured = ctx.getSetting(ctx.db, 'startup_test_printer') || 'POS-58';
      const printerDetails = await listWindowsPrinterDetails();
      const health = buildWindowsPrinterHealth(printerDetails, configured);
      const printers = health.printers.map((p) => p.name);

      return {
        ok: true,
        data: {
          ...health,
          driverAvailable: !!driverPath,
          driverPath,
          installedPrinters: printers,
          printerDetails: health.printers,
          printerConnected: health.ready,
          recoveryAvailable: health.canAutoRecover,
        },
      };
    } catch (e) {
      return { ok: true, data: { driverAvailable: false, installedPrinters: [], printerConnected: false, status: 'offline', ready: false, canAutoRecover: false, needsSelection: false } };
    }
  });

  // ---- List installed Windows printers (for the Settings dropdown) -------
  // Public (no login) so the startup-test config can be set before login.
  ipcMain.handle('pos:printer:listWindowsPrinters', async () => {
    try {
      const printers = await listWindowsPrinters();
      return { ok: true, data: printers };
    } catch (e) {
      return { ok: true, data: [] };
    }
  });
  // Connected queue details plus the route YANKENT will actually use.
  ipcMain.handle('pos:printer:windowsStatus', async () => {
    try {
      const health = await getWindowsPrinterHealth(ctx);
      return { ok: true, data: health };
    } catch (e) {
      return { ok: true, data: { configured: '', printers: [], selected: null, autoSelected: false, code: 'error', status: 'offline', ready: false, canAutoRecover: false, needsSelection: false, error: e.message, message: e.message } };
    }
  });
  // Public, no-input recovery action for login and cashier use. It can only
  // persist the one unambiguous connected thermal queue found by Windows.
  // It never sends a print job, clears the spooler, or guesses between queues.
  ipcMain.handle('pos:printer:autoRecover', async () => {
    try {
      return { ok: true, data: await autoRecoverWindowsPrinter(ctx) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });



  // ---- Startup test print (manual trigger from Settings) -----------------
  // Sends a test print to the configured Windows printer (default "POS-58")
  // in RAW mode.  Used by the Settings page "Test startup print" button so
  // the admin can verify the auto-test works before relying on it.
  guard(ipcMain, 'pos:printer:startupTest', { auth: true }, async () => {
    try {
      const res = await sendStartupTestPrint(ctx);
      if (!res.ok) throw new Error(res.error || 'Test print failed');
      return res;
    } catch (e) {
      throw e;
    }
  });

  // Launch only the installer bundled with YANKENT. Never elevate an
  // arbitrary same-named executable from Downloads.
  ipcMain.handle('pos:printer:setupFromLogin', async () => {
    try {
      const bundledExe = ctx.app.isPackaged
        ? path.join(process.resourcesPath, 'PrinterDriver.exe')
        : path.join(__dirname, '..', '..', '..', 'resources', 'PrinterDriver.exe');
      const exe = fs.existsSync(bundledExe) ? bundledExe : null;
      if (!exe) return { ok: false, error: 'Bundled PrinterDriver.exe was not found.' };
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
    if (typeof ctx.clearPendingSaleOwners === 'function') ctx.clearPendingSaleOwners();
    const counts = {};
    for (const t of ['users','categories','products','product_units','customers','sales','sale_items','stock_movements','loans','loan_payments','loan_events','loan_reminders','settings']) {
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

  // Public: start downloading the update (available pre-login too). Await
  // electron-updater so network/checksum failures reach the renderer.
  ipcMain.handle('pos:update:download', async () => {
    try {
      const result = await updater.downloadUpdate();
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Public: expose updater state and install only a completed download.
  ipcMain.handle('pos:update:state', () => ({ ok: true, data: updater.getState() }));

  ipcMain.handle('pos:update:install', async () => {
    try {
      return { ok: true, data: updater.installUpdate() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  _sendStartupTestPrint: sendStartupTestPrint,
  _listWindowsPrinters: listWindowsPrinters,
  _listWindowsPrinterDetails: listWindowsPrinterDetails,
  _resolveWindowsPrinter: resolveWindowsPrinter,
  _buildWindowsPrinterHealth: buildWindowsPrinterHealth,
  _autoRecoverWindowsPrinter: autoRecoverWindowsPrinter,
  _sendRawFileToPrinter: sendRawFileToPrinter,
};
