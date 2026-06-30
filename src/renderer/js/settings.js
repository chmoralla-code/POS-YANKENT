'use strict';
/* Admin: settings — store info, thermal printer, Telegram, backup/import. */
window.App = window.App || {};
App.views = App.views || {};

App.views.settings = {
  title: 'Settings',
  s: {},

  async render(view) {
    this.viewEl = view;
    this.s = await App.pos.settings.getAll();
    App.currencySymbol = this.s.currency_symbol || '₱';
    App.settingsCache = this.s;
    const online = await App.pos.telegram.isOnline();
    view.innerHTML = `
      <div class="settings-grid">
        <div class="panel"><div class="panel-h">Store Information</div><div class="panel-b">
          ${this._row('Store name', 'store_name', this.s.store_name)}
          ${this._row('Address', 'store_address', this.s.store_address)}
          <div class="row gap wrap">
            <div style="flex:1">${this._row('TIN', 'store_tin', this.s.store_tin)}</div>
            <div style="flex:1">${this._row('Phone', 'store_phone', this.s.store_phone || '')}</div>
          </div>
          <div class="row gap wrap">
            <div style="flex:1">${this._row('VAT rate % (inclusive)', 'vat_rate', this.s.vat_rate)}</div>
            <div style="flex:1">${this._row('Currency symbol', 'currency_symbol', this.s.currency_symbol)}</div>
            <div style="flex:1">${this._row('Receipt width (chars)', 'receipt_width', this.s.receipt_width)}</div>
          </div>
          ${this._row('Receipt footer message', 'receipt_footer', this.s.receipt_footer, 'textarea')}
          <button class="btn btn-primary btn-sm" id="sSaveStore">Save store info</button>
        </div></div>

        <div class="panel"><div class="panel-h">Thermal Printer (ESC/POS)</div><div class="panel-b">
          <div class="row gap"><span id="sBtAvail"></span><span class="muted" id="sBtConn"></span><div class="fill"></div></div>
          <div class="row gap" style="margin:10px 0">
            <button class="btn btn-primary btn-sm" id="sPair">Pair Bluetooth Printer</button>
            <button class="btn btn-ghost btn-sm" id="sTest">Test Print</button>
            <button class="btn btn-ghost btn-sm" id="sSys">System Print Test</button>
          </div>
          <div class="field"><label class="fl">Printer type</label><select id="s_printer_type">
            <option value="bluetooth" ${this.s.printer_type === 'bluetooth' ? 'selected' : ''}>Bluetooth (ESC/POS via Web Bluetooth)</option>
            <option value="system" ${this.s.printer_type === 'system' ? 'selected' : ''}>System printer (Windows-paired thermal / any)</option>
            <option value="none" ${this.s.printer_type === 'none' ? 'selected' : ''}>None</option>
          </select></div>
          <label class="row gap-sm"><input type="checkbox" id="sAuto" ${this.s.printer_auto_print === '1' ? 'checked' : ''}> Auto-print receipt after every sale</label>
          <div class="sec-title" style="margin-top:10px">Advanced (BLE service / characteristic UUIDs)</div>
          <div class="row gap wrap">
            <div style="flex:1">${this._row('Service UUID', 'printer_service_uuid', this.s.printer_service_uuid)}</div>
            <div style="flex:1">${this._row('Characteristic UUID', 'printer_char_uuid', this.s.printer_char_uuid)}</div>
          </div>
          <button class="btn btn-primary btn-sm" id="sSavePrinter" style="margin-top:8px">Save printer settings</button>
        </div></div>

        <div class="panel"><div class="panel-h">Telegram Owner Report</div><div class="panel-b">
          <div class="row gap" style="margin-bottom:10px"><span id="sNet" class="pill">checking…</span><div class="fill"></div></div>
          ${this._row('BotFather token', 'telegram_token', this.s.telegram_token || '', 'password')}
          ${this._row('Chat ID', 'telegram_chat_id', this.s.telegram_chat_id || '')}
          <div class="hint">Token &amp; chat ID are stored only on this laptop. Reports are sent only when online; the POS works offline regardless.</div>
          <div class="row gap" style="margin:10px 0">
            <button class="btn btn-primary btn-sm" id="sSaveTg">Save</button>
            <button class="btn btn-ghost btn-sm" id="sTgTest">Send test message</button>
            <button class="btn btn-ghost btn-sm" id="sTgReport">Send report now</button>
          </div>
          <pre class="receipt" id="sTgPreview" style="font-size:11px"></pre>
        </div></div>

        <div class="panel"><div class="panel-h">Backup &amp; Import</div><div class="panel-b">
          <div class="hint">Export the entire local database (products, sales, users, settings, inventory) into one <b>.yankent</b> file. Restore on any laptop to recover everything.</div>
          <div class="row gap" style="margin:10px 0">
            <button class="btn btn-primary btn-sm" id="sBackup">Backup Data</button>
            <button class="btn btn-ghost btn-sm" id="sImport">Import Data</button>
          </div>
          <div id="sBackupResult"></div>
        </div></div>
      </div>`;
    this._wire(online);
  },

  _row(label, key, val, type = 'text') {
    if (type === 'textarea') return `<div class="field"><label class="fl">${label}</label><textarea id="s_${key}" rows="2">${App.ui.esc(val)}</textarea></div>`;
    return `<div class="field"><label class="fl">${label}</label><input id="s_${key}" type="${type}" value="${App.ui.esc(val)}"></div>`;
  },

  async _wire(online) {
    const v = this.viewEl;
    v.querySelector('#sBtAvail').innerHTML = App.printer.available() ? '<span class="badge admin">Web Bluetooth available</span>' : '<span class="badge cashier">Web Bluetooth unavailable</span>';
    v.querySelector('#sBtConn').textContent = App.printer.isConnected() ? '● Connected: ' + (App.settingsCache.printer_device_name || 'printer') : 'Not connected';
    v.querySelector('#sNet').textContent = online ? '● Online' : '● Offline (POS still works)';
    this._tgPreview();

    const save = async (keys) => {
      for (const k of keys) { const el = v.querySelector('#s_' + k); if (el) await App.pos.settings.set(k, el.value); }
      App.settingsCache = await App.pos.settings.getAll(); App.currencySymbol = App.settingsCache.currency_symbol || '₱';
    };
    v.querySelector('#sSaveStore').onclick = async () => { await save(['store_name','store_address','store_tin','store_phone','vat_rate','currency_symbol','receipt_width','receipt_footer']); App.ui.toast('Store info saved ✓', 'ok'); };
    v.querySelector('#sSavePrinter').onclick = async () => { await save(['printer_service_uuid','printer_char_uuid','printer_type']); const c = v.querySelector('#sAuto').checked ? '1' : '0'; await App.pos.settings.set('printer_auto_print', c); App.settingsCache.printer_auto_print = c; App.ui.toast('Printer settings saved ✓', 'ok'); };
    v.querySelector('#sSaveTg').onclick = async () => { await save(['telegram_token','telegram_chat_id']); App.ui.toast('Telegram settings saved ✓', 'ok'); };

    v.querySelector('#sPair').onclick = async () => { try { const n = await App.printer.pair(); App.ui.toast('Paired: ' + n + ' ✓', 'ok'); v.querySelector('#sBtConn').textContent = '● Connected: ' + n; } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sTest').onclick = async () => { try { if (!App.printer.isConnected()) await App.printer.pair(); await App.printer.testPrint(); App.ui.toast('Test print sent ✓', 'ok'); } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sSys').onclick = async () => { try { const { text } = await App.pos.printer.testPrint(); await App.printer.printTextFallback('YANKENT POS\nPrinter test\n' + new Date().toLocaleString() + '\n\n'); App.ui.toast('System print dialog opened', 'ok'); } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sTgTest').onclick = async () => { try { const r = await App.pos.telegram.test(); r.ok ? App.ui.toast('Test message sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sTgReport').onclick = async () => { try { const r = await App.pos.telegram.sendReport(); r.ok ? App.ui.toast('Report sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); } catch (e) { App.ui.toast(e.message, 'err'); } };

    v.querySelector('#sBackup').onclick = async () => { try { const r = await App.pos.backup.export(); if (r) v.querySelector('#sBackupResult').innerHTML = `<div class="hint">Backup saved: <b>${App.ui.esc(r.path)}</b><br>${Object.entries(r.tables).map(([k, n]) => k + ': ' + n).join(' · ')}</div>`; } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sImport').onclick = async () => {
      const ok = await App.ui.confirm('Importing will REPLACE all current data with the backup contents. Continue?');
      if (!ok) return;
      try { const r = await App.pos.backup.import(); if (r) { App.ui.toast('Import complete ✓', 'ok'); v.querySelector('#sBackupResult').innerHTML = `<div class="hint">Restored from <b>${App.ui.esc(r.path)}</b><br>${Object.entries(r.tables).map(([k, n]) => k + ': ' + n).join(' · ')}</div>`; this.s = await App.pos.settings.getAll(); App.settingsCache = this.s; } }
      catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  async _tgPreview() {
    // Show what the report will look like using current DB (use summary).
    try {
      const s = await App.pos.reports.summary();
      const best = s.bestDay ? `${s.bestDay.label} - ${App.ui.money(s.bestDay.total)}` : '—';
      const txt = `YANKENT POS Sales Report
Today: ${App.ui.money(s.today.total)} / ${s.today.tx} transactions
This Month: ${App.ui.money(s.month.total)}
This Year: ${App.ui.money(s.year.total)}
Best Day: ${best}`;
      this.viewEl.querySelector('#sTgPreview').textContent = txt;
    } catch {}
  },
};
