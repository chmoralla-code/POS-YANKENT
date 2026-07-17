'use strict';
/* Admin: settings — store info, thermal printer, Telegram, backup/import.
 *
 * Uses the same collapsible-section pattern as the Reports tabs: the
 * page shows a list of category titles with one-line previews; the user
 * clicks the section they want to configure and it expands to show the
 * full form.  All sections start collapsed.  Expand/collapse state
 * persists while the view is mounted (sections the user opened stay open
 * across re-renders like saving settings). */
window.App = window.App || {};
App.views = App.views || {};

App.views.settings = {
  title: 'Settings',
  s: {},
  _open: {},

  async render(view) {
    this.viewEl = view;
    this.s = await App.pos.settings.getAll();
    App.currencySymbol = this.s.currency_symbol || '₱';
    App.settingsCache = this.s;
    const online = await App.pos.telegram.isOnline();
    try { this._autoStart = (await App.pos.autostart.get()).enabled; } catch { this._autoStart = false; }

    // One-line previews for each section header — the cashier/admin can
    // scan the whole settings page and only open what they need.
    const printerPreview = App.printer.isConnected()
      ? `● Connected: ${App.settingsCache.printer_device_name || 'printer'}`
      : `Type: ${this.s.printer_type || 'bluetooth'} · ${App.printer.available() ? 'ready' : 'Bluetooth unavailable'}`;
    const startupTestPreview = this.s.startup_test_print !== '0'
      ? `Startup test: ON → ${this.s.startup_test_printer || 'POS-58'}`
      : 'Startup test: OFF';
    const tgPreview = online
      ? `● Online · Chat ID ${this.s.telegram_chat_id || '—'}`
      : `● Offline · ${this.s.telegram_token ? 'token set' : 'not configured'}`;
    const autoStartPreview = this._autoStart ? '● Enabled — POS launches on login' : '○ Disabled';

    // All sections start closed; preserve which ones the user had open
    // across re-renders.
    const isOpen = (k) => (k in this._open ? this._open[k] : false);

    view.innerHTML = `
      <div class="settings-collapse">
        <div class="collapse-section${isOpen('store') ? ' open' : ''}" data-key="store">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">Store Information</div>
              <div class="collapse-preview muted">${App.ui.esc(this.s.store_name || 'YANKENT POS')} · ${this.s.vat_rate || 12}% VAT</div>
            </div>
          </div>
          <div class="collapse-b">
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
              <div style="flex:1">${this._row('Discount % (cashier can apply)', 'discount_percent', this.s.discount_percent || '0')}</div>
            </div>
            ${this._row('Receipt footer message', 'receipt_footer', this.s.receipt_footer, 'textarea')}
            <div class="row gap wrap" style="margin-top:4px">
              <div style="flex:1">${this._row('Idle timeout (minutes, 0=off)', 'session_idle_timeout', this.s.session_idle_timeout || '15')}</div>
            </div>
            <button class="btn btn-primary btn-sm" id="sSaveStore" style="margin-top:8px">Save store info</button>
          </div>
        </div>

        <div class="collapse-section${isOpen('printer') ? ' open' : ''}" data-key="printer">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">Thermal Printer (ESC/POS)</div>
              <div class="collapse-preview muted">${printerPreview} · ${startupTestPreview}</div>
            </div>
          </div>
          <div class="collapse-b">
            <div class="row gap"><span id="sBtAvail"></span><span class="muted" id="sBtConn"></span><div class="fill"></div></div>
            <div class="row gap" style="margin:10px 0">
              <button class="btn btn-primary btn-sm" id="sPair">Pair Bluetooth Printer</button>
              <button class="btn btn-ghost btn-sm" id="sTest">Test Current Printer</button>
              <button class="btn btn-ghost btn-sm" id="sInstallDriver">Install Printer Driver</button>
            </div>
            <div class="hint">For a USB printer, choose <b>System printer</b> and select the connected Windows queue below.</div>
            <div class="field"><label class="fl">Printer type</label><select id="s_printer_type">
              <option value="bluetooth" ${this.s.printer_type === 'bluetooth' ? 'selected' : ''}>Bluetooth (ESC/POS via Web Bluetooth)</option>
              <option value="system" ${this.s.printer_type === 'system' ? 'selected' : ''}>System printer (Windows-paired thermal / any)</option>
              <option value="none" ${this.s.printer_type === 'none' ? 'selected' : ''}>None</option>
            </select></div>
            <label class="row gap-sm"><input type="checkbox" id="sAuto" ${this.s.printer_auto_print === '1' ? 'checked' : ''}> Auto-print receipt after every sale</label>

            <div class="sec-title" style="margin-top:10px">Windows receipt printer</div>
            <div class="hint">Used for USB receipts, reprints, reports, and the startup test. Connected USB queues are detected by their physical port.</div>
            <div class="field"><label class="fl">Selected Windows queue</label><select id="sStartupPrinter"></select></div>
            <div class="hint" id="sPrinterRoute">Checking Windows printers…</div>
            <div class="row gap" style="margin:6px 0">
              <button class="btn btn-ghost btn-sm" id="sStartupTestNow">Test Selected Windows Printer</button>
              <button class="btn btn-ghost btn-sm" id="sRefreshPrinters">Refresh printer list</button>
            </div>

            <div class="sec-title" style="margin-top:10px">Startup auto test-print</div>
            <div class="hint">After a laptop power-on, YANKENT sends one short test to the selected Windows printer. Restarting the app during the same boot does not print again.</div>
            <label class="row gap-sm"><input type="checkbox" id="sStartupTest" ${this.s.startup_test_print !== '0' ? 'checked' : ''}> Auto test-print after laptop power-on</label>

            <div class="sec-title" style="margin-top:10px">Advanced (BLE service / characteristic UUIDs)</div>
            <div class="row gap wrap">
              <div style="flex:1">${this._row('Service UUID', 'printer_service_uuid', this.s.printer_service_uuid)}</div>
              <div style="flex:1">${this._row('Characteristic UUID', 'printer_char_uuid', this.s.printer_char_uuid)}</div>
            </div>
            <button class="btn btn-primary btn-sm" id="sSavePrinter" style="margin-top:8px">Save printer settings</button>
          </div>
        </div>

        <div class="collapse-section${isOpen('telegram') ? ' open' : ''}" data-key="telegram">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">Telegram Owner Report</div>
              <div class="collapse-preview muted">${tgPreview}</div>
            </div>
          </div>
          <div class="collapse-b">
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
          </div>
        </div>

        <div class="collapse-section${isOpen('backup') ? ' open' : ''}" data-key="backup">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">Backup &amp; Import</div>
              <div class="collapse-preview muted">Export or restore the entire local database</div>
            </div>
          </div>
          <div class="collapse-b">
            <div class="hint">Export the entire local database (products, sales, users, settings, inventory) into one <b>.yankent</b> file. Restore on any laptop to recover everything.</div>
            <div class="row gap" style="margin:10px 0">
              <button class="btn btn-primary btn-sm" id="sBackup">Backup Data</button>
              <button class="btn btn-ghost btn-sm" id="sImport">Import Data</button>
            </div>
            <div id="sBackupResult"></div>
          </div>
        </div>

        <div class="collapse-section${isOpen('updates') ? ' open' : ''}" data-key="updates">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">Updates <small id="sVersionLabel" class="muted" style="font-weight:400"></small></div>
              <div class="collapse-preview muted">Check for new versions on GitHub</div>
            </div>
          </div>
          <div class="collapse-b">
            <div class="hint">Check if a new version is available on GitHub. Requires internet.</div>
            <button class="btn btn-ghost btn-sm" id="sCheckUpdates">Check for Updates</button>
            <div id="sUpdateResult"></div>
          </div>
        </div>

        <div class="collapse-section${isOpen('system') ? ' open' : ''}" data-key="system">
          <div class="collapse-h" role="button" tabindex="0">
            <div class="collapse-arrow">▸</div>
            <div class="collapse-info">
              <div class="collapse-title">System</div>
              <div class="collapse-preview muted">${autoStartPreview}</div>
            </div>
          </div>
          <div class="collapse-b">
            <label class="row gap-sm"><input type="checkbox" id="sAutoStart" ${this._autoStart ? 'checked' : ''}> Launch YANKENT POS automatically when the laptop starts</label>
            <div class="hint">When enabled, the POS opens automatically after login so the cashier can start selling without searching for the app.</div>
            <button class="btn btn-primary btn-sm" id="sSaveAutoStart" style="margin-top:8px">Save</button>
          </div>
        </div>
      </div>`;

    const toggleSection = (hdr) => {
      const sec = hdr.parentElement;
      const open = !sec.classList.contains('open');
      sec.classList.toggle('open', open);
      hdr.setAttribute('aria-expanded', String(open));
      const body = sec.querySelector('.collapse-b');
      if (body) body.hidden = !open;
      this._open[sec.dataset.key] = open;
    };
    view.querySelectorAll('.settings-collapse .collapse-section').forEach((sec) => {
      const hdr = sec.querySelector('.collapse-h');
      const body = sec.querySelector('.collapse-b');
      const bodyId = `sSection-${sec.dataset.key}`;
      body.id = bodyId;
      body.hidden = !sec.classList.contains('open');
      hdr.setAttribute('aria-controls', bodyId);
      hdr.setAttribute('aria-expanded', String(sec.classList.contains('open')));
      hdr.addEventListener('keydown', (e) => {
        if (!['Enter', ' '].includes(e.key)) return;
        e.preventDefault(); toggleSection(hdr);
      });
    });
    view.querySelector('.settings-collapse').addEventListener('click', (e) => {
      const hdr = e.target.closest('.collapse-h');
      if (hdr) toggleSection(hdr);
    });

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

    const verEl = v.querySelector('#sVersionLabel');
    if (verEl) { try { verEl.textContent = 'v' + (await App.pos.update.getVersion()); } catch {} }

    const save = async (keys) => {
      for (const k of keys) { const el = v.querySelector('#s_' + k); if (el) await App.pos.settings.set(k, el.value); }
      App.settingsCache = await App.pos.settings.getAll(); App.currencySymbol = App.settingsCache.currency_symbol || '₱';
    };
    v.querySelector('#sSaveStore').onclick = async () => { await save(['store_name','store_address','store_tin','store_phone','vat_rate','currency_symbol','receipt_width','discount_percent','receipt_footer','session_idle_timeout']); App.ui.toast('Store info saved ✓', 'ok'); this._updatePreview('store'); };
    v.querySelector('#sSavePrinter').onclick = async () => {
      await save(['printer_service_uuid','printer_char_uuid','printer_type']);
      const c = v.querySelector('#sAuto').checked ? '1' : '0';
      await App.pos.settings.set('printer_auto_print', c);
      App.settingsCache.printer_auto_print = c;
      // Startup test-print settings
      const st = v.querySelector('#sStartupTest').checked ? '1' : '0';
      await App.pos.settings.set('startup_test_print', st);
      App.settingsCache.startup_test_print = st;
      const printerSel = v.querySelector('#sStartupPrinter');
      if (printerSel) {
        await App.pos.settings.set('startup_test_printer', printerSel.value);
        App.settingsCache.startup_test_printer = printerSel.value;
      }
      App.ui.toast('Printer settings saved ✓', 'ok'); this._updatePreview('printer');
    };
    v.querySelector('#sSaveTg').onclick = async () => { await save(['telegram_token','telegram_chat_id']); App.ui.toast('Telegram settings saved ✓', 'ok'); this._updatePreview('telegram'); };
    v.querySelector('#sSaveAutoStart').onclick = async () => {
      try {
        const enabled = v.querySelector('#sAutoStart').checked;
        const r = await App.pos.autostart.set(enabled);
        this._autoStart = r.enabled;
        App.ui.toast(enabled ? 'Auto-startup enabled ✓' : 'Auto-startup disabled', 'ok');
        this._updatePreview('system');
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };

    const saveSelectedWindowsPrinter = async () => {
      const sel = v.querySelector('#sStartupPrinter');
      if (!sel || !sel.value) throw new Error('Select a Windows printer first');
      await App.pos.settings.set('startup_test_printer', sel.value);
      this.s.startup_test_printer = sel.value;
      App.settingsCache.startup_test_printer = sel.value;
      return sel.value;
    };

    v.querySelector('#sPair').onclick = async () => {
      try {
        const n = await App.printer.pair();
        await App.pos.settings.set('printer_type', 'bluetooth');
        App.settingsCache.printer_type = 'bluetooth';
        v.querySelector('#s_printer_type').value = 'bluetooth';
        App.ui.toast('Paired: ' + n + ' ✓', 'ok');
        v.querySelector('#sBtConn').textContent = '● Connected: ' + n;
        this._updatePreview('printer');
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
    v.querySelector('#sTest').onclick = async () => {
      try {
        const type = v.querySelector('#s_printer_type').value;
        if (type === 'none') throw new Error('Printing is disabled');
        await App.pos.settings.set('printer_type', type);
        App.settingsCache.printer_type = type;
        if (type === 'system') {
          await saveSelectedWindowsPrinter();
          const res = await App.pos.printer.startupTest();
          App.ui.toast('Test print sent to "' + res.printer + '" ✓', 'ok');
        } else {
          if (!App.printer.isConnected()) await App.printer.pair();
          await App.printer.testPrint();
          App.ui.toast('Bluetooth test print sent ✓', 'ok');
        }
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
    v.querySelector('#sInstallDriver').onclick = async () => {
      const ok = await App.ui.confirm('Run the PrinterDriver installer now? Windows will ask for admin permission. After it finishes, set Printer type to "System printer" and test.');
      if (!ok) return;
      try {
        const r = await App.pos.printer.installDriver();
        if (r.launched) App.ui.toast('Driver installer launched — follow the Windows prompts ✓', 'ok');
        else App.ui.toast(r.error || 'Installer not found', 'err');
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };

    // ---- Windows printer discovery and routing ----
    const loadPrinterList = async () => {
      const sel = v.querySelector('#sStartupPrinter');
      const routeEl = v.querySelector('#sPrinterRoute');
      if (!sel) return null;
      sel.innerHTML = '<option>Loading…</option>';
      if (routeEl) routeEl.textContent = 'Checking Windows printers…';
      try {
        const status = await App.pos.printer.windowsStatus();
        const printers = Array.isArray(status.printers) ? status.printers : [];
        const saved = this.s.startup_test_printer || status.configured || 'POS-58';
        const selectedName = status.selected && status.selected.name ? status.selected.name : saved;
        if (!printers.length) {
          sel.innerHTML = `<option value="${App.ui.esc(saved)}">${App.ui.esc(saved)} (not detected)</option>`;
          if (routeEl) routeEl.textContent = status.error || 'No Windows printers were detected.';
          return status;
        }

        sel.innerHTML = printers.map((p) => {
          const state = p.connected === true ? 'connected' : (p.connected === false ? 'disconnected' : 'installed');
          const recommended = status.autoSelected && p.name === selectedName ? ' · recommended' : '';
          const label = p.name + (p.port ? ' — ' + p.port : '') + ' · ' + state + recommended;
          const selected = p.name.toLowerCase() === selectedName.toLowerCase() ? 'selected' : '';
          return `<option value="${App.ui.esc(p.name)}" ${selected}>${App.ui.esc(label)}</option>`;
        }).join('');

        if (!printers.some((p) => p.name.toLowerCase() === selectedName.toLowerCase())) {
          sel.innerHTML = `<option value="${App.ui.esc(selectedName)}" selected>${App.ui.esc(selectedName)} (not detected)</option>` + sel.innerHTML;
        }
        if (routeEl) {
          if (status.selected) {
            routeEl.textContent = status.reason || ('Ready: ' + status.selected.name + (status.selected.port ? ' on ' + status.selected.port : ''));
          } else {
            routeEl.textContent = status.error || 'Choose an installed Windows printer.';
          }
        }
        // Existing USB installations were historically saved as Bluetooth.
        // Show the correct route immediately when no BLE device was ever paired.
        const typeSel = v.querySelector('#s_printer_type');
        if (status.autoSelected && !this.s.printer_device_name && typeSel && typeSel.value === 'bluetooth') {
          typeSel.value = 'system';
        }
        return status;
      } catch (e) {
        const fallback = this.s.startup_test_printer || 'POS-58';
        sel.innerHTML = `<option value="${App.ui.esc(fallback)}">${App.ui.esc(fallback)}</option>`;
        if (routeEl) routeEl.textContent = 'Printer discovery failed: ' + e.message;
        return null;
      }
    };
    loadPrinterList();
    v.querySelector('#sRefreshPrinters').onclick = async () => { await loadPrinterList(); App.ui.toast('Printer list refreshed', 'ok'); };
    v.querySelector('#sStartupTestNow').onclick = async () => {
      const btn = v.querySelector('#sStartupTestNow');
      btn.disabled = true; btn.textContent = 'Printing…';
      try {
        await saveSelectedWindowsPrinter();
        await App.pos.settings.set('printer_type', 'system');
        App.settingsCache.printer_type = 'system';
        v.querySelector('#s_printer_type').value = 'system';
        const res = await App.pos.printer.startupTest();
        const routeEl = v.querySelector('#sPrinterRoute');
        if (routeEl) routeEl.textContent = 'Ready: ' + res.printer;
        App.ui.toast('Test print sent to "' + res.printer + '" ✓', 'ok');
      } catch (e) {
        App.ui.toast(e.message, 'err');
      } finally {
        btn.disabled = false; btn.textContent = 'Test Selected Windows Printer';
      }
    };
    v.querySelector('#sTgTest').onclick = async () => { try { const r = await App.pos.telegram.test(); r.ok ? App.ui.toast('Test message sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sTgReport').onclick = async () => { try { const r = await App.pos.telegram.sendReport(); r.ok ? App.ui.toast('Report sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); } catch (e) { App.ui.toast(e.message, 'err'); } };

    v.querySelector('#sBackup').onclick = async () => { try { const r = await App.pos.backup.export(); if (r) v.querySelector('#sBackupResult').innerHTML = `<div class="hint">Backup saved: <b>${App.ui.esc(r.path)}</b><br>${Object.entries(r.tables).map(([k, n]) => k + ': ' + n).join(' · ')}</div>`; } catch (e) { App.ui.toast(e.message, 'err'); } };
    v.querySelector('#sImport').onclick = async () => {
      const ok = await App.ui.confirm('Importing will REPLACE all current data with the backup contents. Continue?');
      if (!ok) return;
      try { const r = await App.pos.backup.import(); if (r) { App.ui.toast('Import complete ✓', 'ok'); v.querySelector('#sBackupResult').innerHTML = `<div class="hint">Restored from <b>${App.ui.esc(r.path)}</b><br>${Object.entries(r.tables).map(([k, n]) => k + ': ' + n).join(' · ')}</div>`; this.s = await App.pos.settings.getAll(); App.settingsCache = this.s; } }
      catch (e) { App.ui.toast(e.message, 'err'); }
    };

    v.querySelector('#sCheckUpdates').onclick = async () => {
      const el = v.querySelector('#sUpdateResult');
      el.innerHTML = '<div class="hint">Checking…</div>';
      try {
        const r = await App.pos.update.check();
        if (r.devMode) {
          el.innerHTML = '<div class="hint">Dev mode — publish a GitHub Release to test updates.</div>';
        } else if (r.available && App._isNewer(r.version, r.currentVersion)) {
          el.innerHTML = `<div class="hint">v${r.currentVersion} → v${r.version} available</div>`;
          const ok = await App._showWhatsNew(r);
          if (!ok) return;
          const downloaded = await App._showDownloadProgress(r);
          el.innerHTML = '<div class="hint" style="color:var(--ok)">Update downloaded — restart to install.</div>';
          if (!downloaded) {
            el.innerHTML = '<div class="hint" style="color:var(--danger)">Update download failed. Check your internet connection and try again.</div>';
          }
        } else {
          el.innerHTML = '<div class="hint" style="color:var(--ok)">You are up to date (v' + r.currentVersion + ').</div>';
        }
      } catch (e) {
        v.querySelector('#sUpdateResult').innerHTML = `<div class="hint" style="color:var(--danger)">${App.ui.esc(e.message)}</div>`;
      }
    };
  },

  // Refresh a section's one-line preview after a save (so the collapsed
  // header reflects the new value without needing to reopen it).
  async _updatePreview(key) {
    const sec = this.viewEl.querySelector(`.collapse-section[data-key="${key}"]`);
    if (!sec) return;
    this.s = await App.pos.settings.getAll();
    App.settingsCache = this.s;
    const previewEl = sec.querySelector('.collapse-preview');
    if (!previewEl) return;
    if (key === 'store') {
      previewEl.textContent = `${this.s.store_name || 'YANKENT POS'} · ${this.s.vat_rate || 12}% VAT`;
    } else if (key === 'printer') {
      const conn = App.printer.isConnected();
      const stOn = this.s.startup_test_print !== '0';
      const stPrn = this.s.startup_test_printer || 'POS-58';
      previewEl.textContent = conn
        ? `● Connected: ${this.s.printer_device_name || 'printer'} · Startup test: ${stOn ? 'ON → ' + stPrn : 'OFF'}`
        : `Type: ${this.s.printer_type || 'bluetooth'} · ${App.printer.available() ? 'ready' : 'Bluetooth unavailable'} · Startup test: ${stOn ? 'ON → ' + stPrn : 'OFF'}`;
    } else if (key === 'telegram') {
      try {
        const online = await App.pos.telegram.isOnline();
        previewEl.textContent = online
          ? `● Online · Chat ID ${this.s.telegram_chat_id || '—'}`
          : `● Offline · ${this.s.telegram_token ? 'token set' : 'not configured'}`;
        const net = this.viewEl.querySelector('#sNet');
        if (net) net.textContent = online ? '● Online' : '● Offline (POS still works)';
      } catch {}
    } else if (key === 'system') {
      try { this._autoStart = (await App.pos.autostart.get()).enabled; } catch {}
      previewEl.textContent = this._autoStart ? '● Enabled — POS launches on login' : '○ Disabled';
    }
  },

  async _tgPreview() {
    try {
      const s = await App.pos.reports.summary();
      const best = s.bestDay ? `${s.bestDay.label} - ${App.ui.money(s.bestDay.total)}` : '—';
      const txt = `YANKENT POS Sales Report
Today: ${App.ui.money(s.today.total)} / ${s.today.tx} transactions
Yesterday: ${App.ui.money(s.yesterday.total)} / ${s.yesterday.tx} transactions
This Month: ${App.ui.money(s.month.total)}
This Year: ${App.ui.money(s.year.total)}
Best Day: ${best}`;
      const el = this.viewEl.querySelector('#sTgPreview');
      if (el) el.textContent = txt;
    } catch {}
  },
};
