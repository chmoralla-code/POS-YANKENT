'use strict';
/* Thermal printer integration (renderer side).
 * - Primary: ESC/POS over Web Bluetooth (navigator.bluetooth).
 * - Fallback: system print dialog via main process (any Windows-paired
 *   printer, including Bluetooth thermal printers that install as a printer).
 * ESC/POS bytes are encoded in the main process (lib/escpos) so the logic is
 * single-source and unit-tested; the renderer only handles the BLE transport.
 */
window.App = window.App || {};
App.printer = {
  _characteristic: null,
  _deviceName: null,
  _reconnecting: false,

  available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  _uuids() {
    const s = App.settingsCache || {};
    return {
      service: (s.printer_service_uuid || '000018f0-0000-1000-8000-00805f9b34fb').toLowerCase(),
      char: (s.printer_char_uuid || '00002af1-0000-1000-8000-00805f9b34fb').toLowerCase(),
    };
  },

  isConnected() { return !!this._characteristic; },

  /** Pair a Bluetooth ESC/POS printer (requires user gesture). */
  async pair() {
    if (!this.available()) throw new Error('Web Bluetooth not available on this device. Use the system print fallback instead.');
    const { service, char } = this._uuids();
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [service] }], optionalServices: [service] });
    } catch (e) {
      if (e && /cancelled|chooser/i.test(e.message)) throw new Error('Pairing cancelled');
      // Fallback: accept all devices (some printers don't advertise the service)
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [service] });
    }
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(service);
    const ch = await svc.getCharacteristic(char);
    this._characteristic = ch;
    this._deviceName = device.name || 'Bluetooth Printer';
    device.addEventListener('gattserverdisconnected', () => { this._characteristic = null; });
    try { await App.pos.settings.set('printer_device_name', this._deviceName); } catch {}
    return this._deviceName;
  },

  async disconnect() {
    this._characteristic = null;
  },

  /** Auto-reconnect to a previously paired printer after USB replug.
   *  Uses navigator.bluetooth.getDevices() (Chromium 79+) to find the
   *  device by saved name without prompting the user again.  Returns
   *  true if the characteristic was re-acquired. */
  async reconnect() {
    if (this._characteristic) return true;
    const name = (App.settingsCache || {}).printer_device_name;
    if (!name) return false;
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return false;
    try {
      const { service, char } = this._uuids();
      const devices = await navigator.bluetooth.getDevices();
      const dev = devices.find((d) => d.name === name);
      if (!dev) return false;
      if (!dev.gatt.connected) {
        try { await dev.gatt.connect(); } catch { return false; }
      }
      const svc = await dev.gatt.getPrimaryService(service);
      const ch = await svc.getCharacteristic(char);
      this._characteristic = ch;
      this._deviceName = dev.name || name;
      dev.addEventListener('gattserverdisconnected', () => { this._characteristic = null; });
      return true;
    } catch { return false; }
  },

  /** Re-establish the GATT link with retries.
   *
   *  After a laptop power cycle (shutdown → boot, or sleep → resume), the
   *  Bluetooth adapter and USB thermal printers take a few seconds to
   *  re-enumerate.  navigator.bluetooth.getDevices() may return an empty
   *  list immediately after wake even though the printer is physically
   *  connected and powered.  This method retries the reconnect a few
   *  times with delays so a print that comes in right after wake has a
   *  chance to succeed without the cashier having to re-pair.
   *
   *  Returns true if the characteristic was re-acquired. */
  async reconnectWithRetry(attempts = 4, delayMs = 1500) {
    if (this._characteristic) return true;
    if (this._reconnecting) {
      // Another in-flight reconnectWithRetry call is already looping —
      // wait for it to finish by polling the characteristic rather than
      // starting a competing loop that could interleave GATT connects.
      for (let i = 0; i < attempts * 2; i++) {
        if (this._characteristic) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return !!this._characteristic;
    }
    this._reconnecting = true;
    try {
      for (let i = 0; i < attempts; i++) {
        if (this._characteristic) return true;
        const ok = await this.reconnect();
        if (ok) return true;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
      return false;
    } finally {
      this._reconnecting = false;
    }
  },

  /** Ensure a printer is ready before a sale prints.
   *
   *  Called before every print attempt.  If the Bluetooth characteristic
   *  is live, returns { via: 'bluetooth' }.  If it's dead, tries
   *  reconnectWithRetry a few times.  If Bluetooth fails, falls back to the
   *  named Windows thermal printer (default "POS-58") via the winspool RAW
   *  path — the same path the startup auto test-print uses, so sale receipts
   *  print to the USB POS-58 even when printer_type is "bluetooth" and no
   *  Bluetooth device is paired.  Returns { via: 'bluetooth' } or
   *  { via: 'windows' }. */
  async ensureConnected() {
    if (this._characteristic) return { via: 'bluetooth' };
    const s = App.settingsCache || {};
    // Try Bluetooth first (only if the user actually paired a device).
    if (s.printer_device_name && this.available()) {
      const ok = await this.reconnectWithRetry();
      if (ok) return { via: 'bluetooth' };
    }
    // Fall back to the named Windows thermal printer (POS-58) via RAW winspool.
    // This works for USB thermal printers regardless of printer_type — it's
    // the same path the working startup auto test-print uses.
    return { via: 'windows' };
  },

  _decodeB64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },

  /** Write ESC/POS bytes to the connected BLE characteristic (chunked). */
  async _writeBytes(u8) {
    const ch = this._characteristic;
    if (!ch) throw new Error('Printer not connected');
    const MTU = 180;
    for (let i = 0; i < u8.length; i += MTU) {
      const chunk = u8.slice(i, i + MTU);
      try {
        await ch.writeValueWithResponse(chunk);
      } catch {
        try {
          await ch.writeValueWithoutResponse(chunk);
        } catch (e) {
          // The characteristic is stale (USB replug, sleep, range loss).
          // Null it so the next print falls back to the system printer
          // instead of retrying this dead handle forever.
          this._characteristic = null;
          throw e;
        }
      }
      if (u8.length > MTU) await new Promise((r) => setTimeout(r, 40));
    }
  },

  /** Print a receipt by transaction id (auto-print + reprint use this).
   *  Uses ensureConnected so a print right after a power cycle retries the
   *  Bluetooth link, then falls back to the named Windows printer (POS-58). */
  async printReceipt(txnId) {
    const { via } = await this.ensureConnected();
    if (via === 'windows') {
      // Send ESC/POS bytes directly to the named Windows printer via RAW
      // winspool — the proven path that the startup auto test-print uses.
      const res = await App.pos.printer.printReceiptRaw(txnId);
      return res;
    }
    const res = await App.pos.printer.encodeReceipt(txnId);
    if (!res || !res.bytesBase64) throw new Error('Receipt not found');
    await this._writeBytes(this._decodeB64(res.bytesBase64));
  },

  async testPrint() {
    const { via } = await this.ensureConnected();
    if (via === 'windows') {
      // Use the startup test-print path (sends to the named Windows printer).
      const r = await App.pos.printer.startupTest();
      return r;
    }
    const { bytesBase64 } = await App.pos.printer.testPrint();
    await this._writeBytes(this._decodeB64(bytesBase64));
  },

  /** System-printer fallback: render plain text as a printable HTML window. */
  async printTextFallback(text) {
    // Replace the peso sign with "PHP" — many Windows thermal printer
    // drivers render non-ASCII as blank boxes or drop the entire line.
    const safe = text.replace(/\u20b1/g, 'PHP ');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title>
      <style>
        @page { margin: 4mm; }
        body { font-family: 'Consolas','Courier New',monospace; font-size: 11px; line-height: 1.4; margin: 0; padding: 0; white-space: pre-wrap; color: #000; }
      </style></head>
      <body>${App.ui.esc(safe)}</body></html>`;
    await App.pos.printer.printHtml(html);
  },

  async printReceiptFallback(txnId) {
    // Send ESC/POS bytes directly to the named Windows printer (POS-58)
    // via the winspool RAW path — same as the startup auto test-print.
    await App.pos.printer.printReceiptRaw(txnId);
  },

  /** Called after a completed sale; respects the auto-print setting. */
  async autoPrint(txnId) {
    const s = App.settingsCache || {};
    if (s.printer_auto_print !== '1') return { skipped: true };
    // ensureConnected retries Bluetooth, then falls back to the named
    // Windows thermal printer (POS-58) — the proven path the startup
    // auto test-print uses, so sale receipts print to a USB POS-58.
    try {
      await this.printReceipt(txnId);
      return { printed: true };
    } catch (e) {
      App.ui.toast('Auto-print failed: ' + e.message + ' — open the receipt to print manually', 'err');
      return { error: e.message };
    }
  },
};
