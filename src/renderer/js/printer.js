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
        await ch.writeValueWithoutResponse(chunk);
      }
      if (u8.length > MTU) await new Promise((r) => setTimeout(r, 40));
    }
  },

  /** Print a receipt by transaction id (auto-print + reprint use this). */
  async printReceipt(txnId) {
    const res = await App.pos.printer.encodeReceipt(txnId);
    if (!res || !res.bytesBase64) throw new Error('Receipt not found');
    await this._writeBytes(this._decodeB64(res.bytesBase64));
  },

  async testPrint() {
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
    const res = await App.pos.printer.encodeReceipt(txnId);
    if (!res) throw new Error('Receipt not found');
    await this.printTextFallback(res.text);
  },

  /** Called after a completed sale; respects the auto-print setting. */
  async autoPrint(txnId) {
    const s = App.settingsCache || {};
    if (s.printer_auto_print !== '1') return { skipped: true };
    // Primary: Bluetooth ESC/POS if a printer is paired & connected.
    if (this.isConnected()) {
      try { await this.printReceipt(txnId); return { printed: true, via: 'bluetooth' }; }
      catch (e) { App.ui.toast('Auto-print failed: ' + e.message, 'err'); return { error: e.message }; }
    }
    // Optional: a Windows-installed thermal printer (paired as a system printer).
    if (s.printer_type === 'system') {
      try { await this.printReceiptFallback(txnId); return { printed: true, via: 'system' }; }
      catch (e) { App.ui.toast('Auto-print failed: ' + e.message, 'err'); return { error: e.message }; }
    }
    // No printer configured — receipt modal offers manual printing.
    return { skipped: true };
  },
};
