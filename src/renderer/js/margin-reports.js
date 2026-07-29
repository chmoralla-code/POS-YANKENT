'use strict';
/* Margin table Reports — period-based sold-item margin summary (admin). */
window.App = window.App || {};
App.views = App.views || {};

App.views.marginReports = {
  title: 'Margin table Reports',
  viewEl: null,
  period: 'today',
  report: null,
  busy: false,
  _onDocClick: null,

  PERIODS: [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'This Week' },
    { key: 'month', label: 'This Month' },
    { key: 'year', label: 'This Year' },
  ],

  async render(view) {
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    this._onDocClick = null;
    this.viewEl = view;
    this.report = null;
    this.period = 'today';
    view.classList.add('view-margin-reports');
    view.innerHTML = `
      <div class="mrep-page">
        <header class="mrep-header">
          <div class="mrep-heading">
            <h2>Margin table Reports</h2>
            <p>See what sold in a period, remaining stock, and Puhunan / Baligya / Halin totals.</p>
          </div>
          <div class="mrep-header-actions">
            <div class="margin-download" id="mrepDownload">
              <button type="button" class="btn btn-sm" id="mrepDownloadBtn" disabled aria-expanded="false" aria-haspopup="true">Download</button>
              <div class="margin-download-menu" id="mrepDownloadMenu" hidden role="menu">
                <button type="button" role="menuitem" data-export="exportExcel">Excel (.xlsx)</button>
                <button type="button" role="menuitem" data-export="exportPdf">PDF</button>
              </div>
            </div>
          </div>
        </header>

        <section class="mrep-panel" aria-labelledby="mrepPeriodHeading">
          <div class="mrep-panel-copy">
            <h3 id="mrepPeriodHeading">Choose period</h3>
            <p>Pick one period, then generate the report from completed sales.</p>
          </div>
          <div class="mrep-periods" role="radiogroup" aria-label="Report period" id="mrepPeriods">
            ${this.PERIODS.map((p) => `
              <button type="button" class="mrep-period${p.key === this.period ? ' is-active' : ''}"
                role="radio" aria-checked="${p.key === this.period ? 'true' : 'false'}"
                data-period="${p.key}">${App.ui.esc(p.label)}</button>
            `).join('')}
          </div>
          <div class="mrep-actions">
            <button type="button" class="btn btn-primary mrep-generate" id="mrepGenerate">Generate</button>
            <p class="mrep-hint muted" id="mrepHint">Cost uses the same ₱10 / ₱15 / ₱20 rules as Generate Margin Table (or saved manual puhunan). ${App.reporting.isUtangSeparated() ? 'Separate is on, so Utang is excluded.' : 'Separate is off, so Utang is included.'}</p>
          </div>
        </section>

        <section class="mrep-result" id="mrepResult" aria-live="polite">
          <div class="mrep-empty muted">Choose a period and click Generate.</div>
        </section>
      </div>`;

    view.querySelector('#mrepPeriods').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-period]');
      if (!btn || this.busy) return;
      const nextPeriod = btn.dataset.period;
      if (nextPeriod === this.period) return;
      this.period = nextPeriod;
      this.report = null;
      view.querySelectorAll('.mrep-period').forEach((el) => {
        const on = el.dataset.period === this.period;
        el.classList.toggle('is-active', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      this._closeDownload();
      const download = view.querySelector('#mrepDownloadBtn');
      if (download) download.disabled = true;
      const result = view.querySelector('#mrepResult');
      if (result) {
        result.innerHTML = '<div class="mrep-empty muted">Click Generate to load the selected period.</div>';
      }
    });

    view.querySelector('#mrepGenerate').onclick = () => this._generate();

    const downloadBtn = view.querySelector('#mrepDownloadBtn');
    const downloadMenu = view.querySelector('#mrepDownloadMenu');
    downloadBtn.onclick = () => {
      if (downloadBtn.disabled) return;
      const open = downloadMenu.hidden;
      downloadMenu.hidden = !open;
      downloadBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    downloadMenu.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-export]');
      if (!item) return;
      this._closeDownload();
      await this._export(item.dataset.export);
    });
    document.addEventListener('click', this._onDocClick = (e) => {
      if (!view.contains(e.target)) return;
      if (!e.target.closest('#mrepDownload')) this._closeDownload();
    });
  },

  destroy() {
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    this._onDocClick = null;
    if (this.viewEl) {
      this.viewEl.classList.remove('view-margin-reports');
      this.viewEl.innerHTML = '';
    }
    this.viewEl = null;
    this.report = null;
    this.busy = false;
  },

  _closeDownload() {
    const menu = this.viewEl && this.viewEl.querySelector('#mrepDownloadMenu');
    const btn = this.viewEl && this.viewEl.querySelector('#mrepDownloadBtn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  },

  _setBusy(busy) {
    this.busy = busy;
    if (!this.viewEl) return;
    const gen = this.viewEl.querySelector('#mrepGenerate');
    if (gen) {
      gen.disabled = busy;
      gen.textContent = busy ? 'Generating…' : 'Generate';
    }
    this.viewEl.querySelectorAll('.mrep-period').forEach((el) => {
      el.disabled = busy;
    });
  },

  async _generate() {
    const view = this.viewEl;
    if (!view) return;
    this._setBusy(true);
    this._closeDownload();
    try {
      const report = await App.pos.marginReports.generate(this.period);
      if (this.viewEl !== view) return;
      this.report = report;
      this._renderResult(report);
      const dl = this.viewEl.querySelector('#mrepDownloadBtn');
      if (dl) dl.disabled = !(report && report.rows && report.rows.length);
    } catch (e) {
      if (this.viewEl !== view) return;
      this.report = null;
      const dl = this.viewEl.querySelector('#mrepDownloadBtn');
      if (dl) dl.disabled = true;
      App.ui.toast(e.message || 'Could not generate report', 'err');
      this.viewEl.querySelector('#mrepResult').innerHTML =
        `<div class="mrep-empty muted">Could not generate the report.</div>`;
    } finally {
      if (this.viewEl === view) this._setBusy(false);
    }
  },

  _moneyOrDash(value) {
    if (value == null || value === '') return '—';
    return App.ui.money(value);
  },

  _stockCell(row) {
    if (row.is_service || row.stock == null || row.stock === '') return '—';
    return App.ui.qty(row.stock);
  },

  _renderResult(report) {
    const el = this.viewEl.querySelector('#mrepResult');
    if (!report || !report.rows || !report.rows.length) {
      el.innerHTML = `<div class="mrep-empty muted">No sales in this period.</div>`;
      return;
    }
    const t = report.totals || {};
    const missing = Number(t.missing_cost_count) || 0;
    const tip = missing
      ? `<p class="mrep-note">Note: ${missing} item${missing === 1 ? '' : 's'} need a saved manual puhunan — those rows are blank in Puhunan / Halin and excluded from those totals.</p>`
      : '';

    el.innerHTML = `
      <div class="mrep-result-head">
        <div>
          <h3>${App.ui.esc(report.label)}</h3>
          <p class="muted">${report.rows.length} item${report.rows.length === 1 ? '' : 's'} sold · ${report.separateUtang ? 'Utang excluded' : 'Utang included'} · Generated ${App.ui.esc(new Date(report.generatedAt).toLocaleString())}</p>
        </div>
      </div>
      ${tip}
      <div class="mrep-table-wrap">
        <table class="mrep-table">
          <thead>
            <tr>
              <th>Item name</th>
              <th class="num">Qty sold</th>
              <th class="num">Stock left</th>
              <th class="num">Puhunan (Cost)</th>
              <th class="num">Baligya (Sales)</th>
              <th class="num">Halin (Gross Profit)</th>
            </tr>
          </thead>
          <tbody>
            ${report.rows.map((row) => `
              <tr class="${row.needs_manual_cost ? 'is-pending-cost' : ''}">
                <td>${App.ui.esc(row.name)}</td>
                <td class="num">${App.ui.qty(row.qty_sold)}</td>
                <td class="num">${this._stockCell(row)}</td>
                <td class="num">${this._moneyOrDash(row.puhunan)}</td>
                <td class="num">${App.ui.money(row.baligya)}</td>
                <td class="num">${this._moneyOrDash(row.halin)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th class="num">${App.ui.qty(t.qty_sold || 0)}</th>
              <th class="num"></th>
              <th class="num">${App.ui.money(t.puhunan || 0)}</th>
              <th class="num">${App.ui.money(t.baligya || 0)}</th>
              <th class="num">${App.ui.money(t.halin || 0)}</th>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  async _export(method) {
    if (!this.report || !this.period) return;
    try {
      const result = await App.pos.marginReports[method](this.period);
      if (result && result.canceled) return;
      App.ui.toast(`Saved ${method === 'exportExcel' ? 'Excel' : 'PDF'} ✓`, 'ok');
    } catch (e) {
      App.ui.toast(e.message || 'Export failed', 'err');
    }
  },
};
