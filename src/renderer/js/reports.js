'use strict';
/* Admin: sales reports (today / month / year, best-selling, by cashier,
 * by day, best sales day) with CSV export and printable view.
 *
 * Tabbed view:
 *   1. "Sales Reports"       — existing analytics, best-selling, by cashier, etc.
 *   2. "Restock History" — every time new stock is added to a product
 *      (restock / positive stock adjustment), showing when each product was
 *      restocked, the quantity added, the reason, and who did it. */
window.App = window.App || {};
App.views = App.views || {};

App.views.reports = {
  title: 'Reports & Stock',
  data: null,
  from: '', to: '',
  tab: 'sales',          // 'sales' | 'delivery'
  // Delivery tab state (stock restock history)
  dFrom: '', dTo: '', dQ: '',
  dData: null,

  async render(view) {
    this.viewEl = view;
    const salesActive = this.tab === 'sales';
    view.innerHTML = `
      <div class="reports-page">
        <div class="tabs reports-tabs" id="rTabs" role="tablist" aria-label="Reports sections">
          <button type="button" id="rTabSales" class="tab ${salesActive ? 'active' : ''}" data-tab="sales" role="tab" aria-controls="rSales" aria-selected="${salesActive}" tabindex="${salesActive ? '0' : '-1'}">Sales Reports</button>
          <button type="button" id="rTabDelivery" class="tab ${salesActive ? '' : 'active'}" data-tab="delivery" role="tab" aria-controls="rDelivery" aria-selected="${!salesActive}" tabindex="${salesActive ? '-1' : '0'}">Stock &amp; Restock History</button>
        </div>
        <div id="rSales" class="tab-pane reports-pane ${salesActive ? '' : 'hidden'}" role="tabpanel" aria-labelledby="rTabSales"></div>
        <div id="rDelivery" class="tab-pane reports-pane ${salesActive ? 'hidden' : ''}" role="tabpanel" aria-labelledby="rTabDelivery"></div>
      </div>`;
    const tabs = [...view.querySelectorAll('#rTabs .tab')];
    tabs.forEach((t) => t.onclick = () => this._switchTab(t.dataset.tab));
    view.querySelector('#rTabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      const next = e.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    });
    await this._load();
  },

  _switchTab(tab) {
    this.tab = tab;
    const v = this.viewEl;
    v.querySelectorAll('#rTabs .tab').forEach((x) => {
      const active = x.dataset.tab === tab;
      x.classList.toggle('active', active);
      x.setAttribute('aria-selected', String(active));
      x.tabIndex = active ? 0 : -1;
    });
    v.querySelector('#rSales').classList.toggle('hidden', tab !== 'sales');
    v.querySelector('#rDelivery').classList.toggle('hidden', tab !== 'delivery');
    if (tab === 'delivery') {
      if (!this.dData) this._loadDeliveries();
      else this._renderDelivery();
    }
  },

  // ===== Sales Reports tab ===============================================
  // Layout: 4 always-visible summary stat cards, then a stack of collapsible
  // sections (Today's Breakdown, Payment Methods, Top Products, Top Cashiers,
  // Daily Trend, Recent Sales, Refunds).  Each section shows a title with a
  // mini-preview, and clicks to expand/collapse the full data.
  _renderSalesShell() {
    const v = this.viewEl.querySelector('#rSales');
    v.innerHTML = `
      <header class="reports-header">
        <div class="reports-heading">
          <div class="reports-eyebrow">Sales intelligence</div>
          <h2>Sales performance</h2>
          <p>Review revenue, product performance, cashier activity, payments, and refunds.</p>
        </div>
        <div class="reports-actions" aria-label="Report actions">
          <button type="button" class="btn btn-sm btn-ghost" id="rSendTg">Send to Telegram</button>
          <button type="button" class="btn btn-sm btn-ghost" id="rPrint">Print report</button>
          <span class="reports-action-separator" aria-hidden="true"></span>
          <button type="button" class="btn btn-sm btn-danger" id="rReset" title="Permanently erase sales, refunds, and stock movements">Erase sales data…</button>
        </div>
      </header>
      <section class="report-filter-panel" aria-labelledby="rFilterTitle">
        <div class="report-filter-summary">
          <span id="rFilterTitle">Report period</span>
          <strong id="rPeriodLabel" aria-live="polite">${App.ui.esc(this._periodLabel())}</strong>
        </div>
        <div class="report-filter-fields">
          <div class="report-date-field"><label class="fl" for="rFrom">From</label><input id="rFrom" type="date" value="${App.ui.esc(this.from)}"></div>
          <div class="report-date-field"><label class="fl" for="rTo">To</label><input id="rTo" type="date" value="${App.ui.esc(this.to)}"></div>
          <button type="button" class="btn btn-primary btn-sm" id="rGo">Apply range</button>
          <button type="button" class="btn btn-sm btn-ghost" id="rClear" title="Show all recorded sales" ${!this.from && !this.to ? 'disabled' : ''}>Clear dates</button>
        </div>
      </section>
      <div class="reports-section-heading">
        <div><h3>Store overview</h3><p>Rolling totals for today, yesterday, this month, and this year.</p></div>
      </div>
      <div id="rStats" class="stat-grid"></div>
      <div class="reports-section-heading reports-details-heading">
        <div><h3>Report details</h3><p id="rDetailsPeriod">${App.ui.esc(this._periodLabel())} · date filters apply to period-based sections.</p></div>
        <button type="button" class="btn btn-sm btn-ghost" id="rExpandAll">Expand all</button>
      </div>
      <div class="collapse-list report-sections" id="rSections"></div>`;
    this._wireSales();
  },

  _wireSales() {
    const v = this.viewEl.querySelector('#rSales');
    const fromEl = v.querySelector('#rFrom');
    const toEl = v.querySelector('#rTo');
    const syncDateBounds = () => { toEl.min = fromEl.value || ''; fromEl.max = toEl.value || ''; };
    fromEl.addEventListener('change', syncDateBounds); toEl.addEventListener('change', syncDateBounds); syncDateBounds();
    v.querySelector('#rGo').onclick = () => this._applySalesFilters(fromEl.value, toEl.value);
    v.querySelector('#rClear').onclick = async () => {
      this.from = ''; this.to = ''; fromEl.value = ''; toEl.value = ''; syncDateBounds();
      await this._loadSales();
    };
    v.querySelector('#rPrint').onclick = () => this._print();
    v.querySelector('#rReset').onclick = () => this._resetSales();
    v.querySelector('#rSendTg').onclick = async () => {
      const b = v.querySelector('#rSendTg'); b.disabled = true; b.textContent = 'Sending…';
      try { const r = await App.pos.telegram.sendReport(); r.ok ? App.ui.toast('Report sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); }
      catch (e) { App.ui.toast(e.message, 'err'); }
      b.disabled = false; b.textContent = 'Send to Telegram';
    };
    v.querySelector('#rExpandAll').onclick = () => {
      const sections = [...v.querySelectorAll('.collapse-section')];
      const shouldOpen = sections.some((s) => !s.classList.contains('open'));
      sections.forEach((s) => this._setSectionOpen(s, shouldOpen));
      this._syncExpandAll();
    };
    // Click anywhere on a section header to toggle expand/collapse
    v.querySelector('#rSections').addEventListener('click', (e) => {
      // CSV button on a section header
      const csvBtn = e.target.closest('[data-x]');
      if (csvBtn) { this._csv(csvBtn.dataset.x); return; }
      const toggle = e.target.closest('.collapse-toggle');
      if (toggle) {
        const sec = toggle.closest('.collapse-section');
        this._setSectionOpen(sec, !sec.classList.contains('open'));
        this._syncExpandAll();
        return;
      }
      // Reprint on recent sales row
      const txn = e.target.closest('[data-txn]')?.dataset.txn;
      if (txn) { App.printer.printReceiptFallback(txn).catch((err) => App.ui.toast(err.message, 'err')); }
    });
  },

  async _applySalesFilters(from, to) {
    if (from && to && from > to) {
      App.ui.toast('The From date must be earlier than or equal to the To date', 'err');
      this.viewEl.querySelector('#rFrom').focus();
      return;
    }
    this.from = from; this.to = to;
    await this._loadSales();
  },

  _setSectionOpen(section, open) {
    if (!section) return;
    section.classList.toggle('open', open);
    const toggle = section.querySelector('.collapse-toggle');
    const body = section.querySelector('.collapse-b');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (body) body.hidden = !open;
  },

  _syncExpandAll() {
    const v = this.viewEl && this.viewEl.querySelector('#rSales');
    if (!v) return;
    const sections = [...v.querySelectorAll('.collapse-section')];
    const button = v.querySelector('#rExpandAll');
    if (button) button.textContent = sections.length && sections.every((s) => s.classList.contains('open')) ? 'Collapse all' : 'Expand all';
  },

  _periodLabel() {
    if (this.from && this.to) return `${this.from} to ${this.to}`;
    if (this.from) return `From ${this.from}`;
    if (this.to) return `Through ${this.to}`;
    return 'All recorded sales';
  },

  async _loadSales() {
    const pane = this.viewEl.querySelector('#rSales');
    const applyButton = pane && pane.querySelector('#rGo');
    if (pane) pane.setAttribute('aria-busy', 'true');
    if (applyButton) { applyButton.disabled = true; applyButton.textContent = 'Loading…'; }
    const f = { from: this.from || undefined, to: this.to || undefined };
    try {
      const [summary, best, csr, day, list, analytics, refunds, refundSummary] = await Promise.all([
        App.pos.reports.summary(),
        App.pos.reports.bestSelling(f),
        App.pos.reports.byCashier(f),
        App.pos.reports.salesByDay(f),
        App.pos.sales.list(f),
        App.pos.reports.analytics(),
        App.pos.refunds.list(f),
        App.pos.refunds.summary(),
      ]);
      this.data = { summary, best, csr, day, list, analytics, refunds, refundSummary };
      this._renderSales();
    } catch (e) {
      App.ui.toast(e.message || 'Unable to load reports', 'err');
      if (!this.data) {
        const sections = pane && pane.querySelector('#rSections');
        if (sections) sections.innerHTML = '<div class="report-error" role="alert">Reports could not be loaded. Check the database and try again.</div>';
      }
    } finally {
      if (pane) pane.setAttribute('aria-busy', 'false');
      if (applyButton) { applyButton.disabled = false; applyButton.textContent = 'Apply range'; }
    }
  },

  _renderSales() {
    const d = this.data; const v = this.viewEl.querySelector('#rSales');
    const s = d.summary;
    const a = d.analytics || {};
    const periodLabel = this._periodLabel();
    const periodEl = v.querySelector('#rPeriodLabel');
    const detailsEl = v.querySelector('#rDetailsPeriod');
    if (periodEl) periodEl.textContent = periodLabel;
    if (detailsEl) detailsEl.textContent = `${periodLabel} · date filters apply to period-based sections.`;
    const clearButton = v.querySelector('#rClear');
    if (clearButton) clearButton.disabled = !this.from && !this.to;

    // ---- Summary stat cards (always visible) ---------------------------
    v.querySelector('#rStats').innerHTML = `
      <article class="stat report-stat">
        <div class="k">Today</div>
        <div class="v">${App.ui.money(s.today.total)}</div>
        <small class="muted">${s.today.tx} transaction${s.today.tx === 1 ? '' : 's'}</small>
      </article>
      <article class="stat report-stat">
        <div class="k">Yesterday</div>
        <div class="v">${App.ui.money(s.yesterday.total)}</div>
        <small class="muted">${s.yesterday.tx} transaction${s.yesterday.tx === 1 ? '' : 's'}</small>
      </article>
      <article class="stat report-stat">
        <div class="k">This Month</div>
        <div class="v">${App.ui.money(s.month.total)}</div>
        <small class="muted">${s.month.tx} transaction${s.month.tx === 1 ? '' : 's'}</small>
      </article>
      <article class="stat report-stat">
        <div class="k">This Year</div>
        <div class="v">${App.ui.money(s.year.total)}</div>
        <small class="muted">${s.year.tx} transaction${s.year.tx === 1 ? '' : 's'}</small>
      </article>`;

    // ---- Render collapsible sections ----------------------------------
    const avg = a.today && a.today.tx > 0 ? a.avgTx : 0;
    const items = Math.round(a.itemsSold || 0);
    const bestDay = s.bestDay;
    const pays = a.payBreak || [];
    const best = d.best || [];
    const csr = d.csr || [];
    const day = d.day || [];
    const list = d.list || [];
    const refunds = d.refunds || [];
    const refundTotal = refunds.reduce((sum, r) => sum + Number(r.total || 0), 0);

    // Build preview summaries (one line, muted) for each section header
    const sections = [
      {
        key: 'breakdown',
        title: 'Performance highlights',
        preview: `Today avg ${App.ui.money(avg)} · ${items} items · Record day ${bestDay ? App.ui.money(bestDay.total) : '—'}`,
        csv: null,
        body: `<div class="kv">
          <div class="kv-row"><span class="kv-k">Today's average transaction</span><span class="kv-v">${App.ui.money(avg)}</span></div>
          <div class="kv-row"><span class="kv-k">Items sold today</span><span class="kv-v">${items}</span></div>
          <div class="kv-row"><span class="kv-k">Best sales day (all time)</span><span class="kv-v">${bestDay ? App.ui.money(bestDay.total) : '—'}</span></div>
          <div class="kv-row"><span class="kv-k muted">${bestDay ? bestDay.label : 'no sales yet'}</span><span class="kv-v muted">${bestDay ? '↗ peak' : ''}</span></div>
        </div>`,
      },
      {
        key: 'payments',
        title: 'Payment methods today',
        preview: pays.length ? pays.map((p) => `${p.payment_method} ${App.ui.money(p.total)}`).join(' · ') : 'No payments today',
        csv: null,
        body: pays.length ? `<div class="kv">
          ${(() => {
            const payTotal = pays.reduce((s, p) => s + Number(p.total || 0), 0);
            const payColors = { cash: '#2e7d32', card: '#1565c0', ewallet: '#f9a825', account: '#6a1b9a' };
            return pays.map((p) => {
              const pct = payTotal > 0 ? Math.round((Number(p.total) / payTotal) * 100) : 0;
              const col = payColors[p.payment_method] || '#757575';
              return `<div class="pay-row">
                <div class="pay-lbl">${App.ui.esc(p.payment_method)} <span class="muted">${pct}%</span></div>
                <div class="pay-bar-wrap"><div class="pay-bar" style="width:${pct}%;background:${col}"></div></div>
                <div class="pay-amt">${App.ui.money(p.total)}</div>
              </div>`;
            }).join('');
          })()}
          <div class="kv-row" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><span class="kv-k">Total</span><span class="kv-v" style="font-weight:700">${App.ui.money(pays.reduce((s, p) => s + Number(p.total || 0), 0))}</span></div>
        </div>` : '<div class="empty-state muted">No payments today</div>',
      },
      {
        key: 'products',
        title: 'Top Products',
        preview: best.length ? `Top: ${App.ui.esc(best[0].name)} (${App.ui.money(best[0].total)})` : 'No product sales',
        csv: 'bestSelling',
        body: best.length ? `<table class="tbl compact"><thead><tr><th>#</th><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead><tbody>
          ${best.slice(0, 10).map((b, i) => `<tr><td class="muted">${i + 1}</td><td>${App.ui.esc(b.name)}</td><td class="right">${App.ui.qty(b.qty)}</td><td class="right">${App.ui.money(b.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state muted">No product sales in this period</div>',
      },
      {
        key: 'cashiers',
        title: 'Top Cashiers',
        preview: csr.length ? `Top: ${App.ui.esc(csr[0].cashier_name)} (${App.ui.money(csr[0].total)})` : 'No cashier sales',
        csv: 'byCashier',
        body: csr.length ? `<table class="tbl compact"><thead><tr><th>#</th><th>Cashier</th><th class="right">Tx</th><th class="right">Revenue</th></tr></thead><tbody>
          ${csr.slice(0, 10).map((c, i) => `<tr><td class="muted">${i + 1}</td><td>${App.ui.esc(c.cashier_name)}</td><td class="right">${c.tx}</td><td class="right">${App.ui.money(c.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state muted">No cashier sales in this period</div>',
      },
      {
        key: 'daily',
        title: 'Daily Trend',
        preview: day.length ? `${day.length} day${day.length === 1 ? '' : 's'} · Peak ${App.ui.money(day.reduce((m, x) => Math.max(m, Number(x.total || 0)), 0))}` : 'No daily data',
        csv: 'salesByDay',
        body: day.length ? (() => {
          const dayMax = day.reduce((m, x) => Math.max(m, Number(x.total || 0)), 0) || 1;
          return `<div class="spark-list">${day.slice(0, 30).map((x) => {
            const pct = Math.round((Number(x.total) / dayMax) * 100);
            return `<div class="spark-row">
              <div class="spark-date">${App.ui.esc(x.date)}</div>
              <div class="spark-bar-wrap"><div class="spark-bar" style="width:${pct}%"></div></div>
              <div class="spark-amt">${App.ui.money(x.total)}</div>
              <div class="spark-tx muted">${x.tx} tx</div>
            </div>`;
          }).join('')}</div>`;
        })() : '<div class="empty-state muted">No sales in this period</div>',
      },
      {
        key: 'sales',
        title: 'Recent Sales',
        preview: list.length ? `${list.length} record${list.length === 1 ? '' : 's'} in this period` : 'No sales',
        csv: 'sales',
        body: list.length ? `<div style="overflow:auto;max-height:400px"><table class="tbl"><thead><tr><th>Txn</th><th>Date</th><th>Cashier</th><th>Customer</th><th class="right">Total</th><th>Pay</th><th></th></tr></thead><tbody>
          ${list.map((r) => `<tr>
            <td class="mono" data-txn="${App.ui.esc(r.txn_id)}" style="cursor:pointer;text-decoration:underline" title="Click to reprint">${App.ui.esc(r.txn_id)}</td>
            <td>${App.ui.fmtDate(r.datetime)}</td>
            <td>${App.ui.esc(r.cashier_name)}</td>
            <td>${App.ui.esc(r.customer_name)}</td>
            <td class="right">${App.ui.money(r.total)}</td>
            <td><span class="muted">${App.ui.esc(r.payment_method)}</span></td>
            <td><button class="btn btn-sm btn-ghost" data-txn="${App.ui.esc(r.txn_id)}">Reprint</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state muted">No sales in this period</div>',
      },
      {
        key: 'refunds',
        title: 'Refunds',
        preview: refunds.length ? `${refunds.length} in this period · ${App.ui.money(refundTotal)}` : 'No refunds in this period',
        csv: 'refunds',
        body: refunds.length ? `<div style="overflow:auto;max-height:240px"><table class="tbl"><thead><tr><th>Refund ID</th><th>Original Txn</th><th>Date</th><th>Cashier</th><th class="right">Amount</th><th>Reason</th></tr></thead><tbody>
          ${refunds.map((r) => `<tr style="color:var(--danger)"><td class="mono">${App.ui.esc(r.refund_txn_id)}</td><td class="mono">${App.ui.esc(r.original_txn_id)}</td><td>${App.ui.fmtDate(r.datetime)}</td><td>${App.ui.esc(r.cashier_name)}</td><td class="right">${App.ui.money(r.total)}</td><td class="muted">${App.ui.esc(r.reason || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state muted">No refunds</div>',
      },
    ];

    // Open the most decision-useful summaries on first visit. Expand state
    // is preserved across re-renders when the date range changes.
    const openDefaults = { breakdown: true };
    const container = v.querySelector('#rSections');
    const prevOpen = {};
    container.querySelectorAll('.collapse-section').forEach((s) => { prevOpen[s.dataset.key] = s.classList.contains('open'); });
    const isOpen = (k) => (k in prevOpen ? prevOpen[k] : openDefaults[k]);

    container.innerHTML = sections.map((s) => {
      const open = !!isOpen(s.key);
      const bodyId = `rSection-${s.key}`;
      return `<section class="collapse-section${open ? ' open' : ''}" data-key="${s.key}">
        <div class="collapse-h">
          <button type="button" class="collapse-toggle" aria-expanded="${open}" aria-controls="${bodyId}">
            <span class="collapse-arrow" aria-hidden="true">▸</span>
            <span class="collapse-info">
              <span class="collapse-title">${App.ui.esc(s.title)}</span>
              <span class="collapse-preview muted">${s.preview}</span>
            </span>
          </button>
          ${s.csv ? `<button type="button" class="btn btn-sm btn-ghost collapse-action" data-x="${s.csv}" title="Export ${App.ui.esc(s.title)} as CSV">Export CSV</button>` : ''}
        </div>
        <div class="collapse-b" id="${bodyId}"${open ? '' : ' hidden'}>${s.body}</div>
      </section>`;
    }).join('');
    this._syncExpandAll();
  },

  async _load() {
    if (this.tab === 'sales') {
      this._renderSalesShell();
      await this._loadSales();
    } else {
      await this._loadDeliveries();
    }
  },

  // ===== Restock History tab (stock restock log) =========================
  // Same collapsible pattern as the Sales tab: stat cards always visible,
  // then a collapsible section (Restock Records) that expands on click.
  _renderDeliveryShell() {
    const v = this.viewEl.querySelector('#rDelivery');
    v.innerHTML = `
      <header class="reports-header">
        <div class="reports-heading">
          <div class="reports-eyebrow">Inventory intelligence</div>
          <h2>Stock &amp; restock history</h2>
          <p>Trace incoming stock by product, source, reason, location, and staff member.</p>
        </div>
        <div class="reports-actions" aria-label="Restock history actions">
          <button type="button" class="btn btn-sm btn-ghost" id="dCsv">Export CSV</button>
          <button type="button" class="btn btn-sm btn-ghost" id="dPrint">Print history</button>
        </div>
      </header>
      <section class="report-filter-panel" aria-labelledby="dFilterTitle">
        <div class="report-filter-summary">
          <span id="dFilterTitle">Inventory activity</span>
          <strong id="dPeriodLabel" aria-live="polite">${App.ui.esc(this._deliveryFilterLabel())}</strong>
        </div>
        <div class="report-filter-fields">
          <div class="report-date-field"><label class="fl" for="dFrom">From</label><input id="dFrom" type="date" value="${App.ui.esc(this.dFrom)}"></div>
          <div class="report-date-field"><label class="fl" for="dTo">To</label><input id="dTo" type="date" value="${App.ui.esc(this.dTo)}"></div>
          <div class="report-search-field"><label class="fl" for="dQ">Search records</label><input id="dQ" type="search" value="${App.ui.esc(this.dQ)}" placeholder="Product, SKU, reason, location…"></div>
          <button type="button" class="btn btn-primary btn-sm" id="dGo">Apply filters</button>
          <button type="button" class="btn btn-sm btn-ghost" id="dClear" ${!this.dFrom && !this.dTo && !this.dQ ? 'disabled' : ''}>Clear filters</button>
        </div>
      </section>
      <div class="reports-section-heading">
        <div><h3>Inventory overview</h3><p>Totals reflect the active period and search filters.</p></div>
      </div>
      <div id="dStats" class="stat-grid"></div>
      <div class="reports-section-heading reports-details-heading">
        <div><h3>Restock records</h3><p id="dRecordsSummary">Loading inventory activity…</p></div>
        <button type="button" class="btn btn-sm btn-ghost" id="dShowRecords" aria-expanded="false" aria-controls="dRecordsWrap">Show records</button>
      </div>
      <div id="dRecordsWrap" class="report-records" hidden></div>`;
    this._wireDelivery();
  },

  _wireDelivery() {
    const v = this.viewEl.querySelector('#rDelivery');
    const fromEl = v.querySelector('#dFrom');
    const toEl = v.querySelector('#dTo');
    const searchEl = v.querySelector('#dQ');
    const syncDateBounds = () => { toEl.min = fromEl.value || ''; fromEl.max = toEl.value || ''; };
    fromEl.addEventListener('change', syncDateBounds); toEl.addEventListener('change', syncDateBounds); syncDateBounds();
    v.querySelector('#dGo').onclick = async () => {
      if (fromEl.value && toEl.value && fromEl.value > toEl.value) {
        App.ui.toast('The From date must be earlier than or equal to the To date', 'err');
        fromEl.focus(); return;
      }
      this.dFrom = fromEl.value; this.dTo = toEl.value; this.dQ = searchEl.value.trim();
      await this._loadDeliveries();
    };
    v.querySelector('#dClear').onclick = async () => {
      this.dFrom = ''; this.dTo = ''; this.dQ = '';
      fromEl.value = ''; toEl.value = ''; searchEl.value = ''; syncDateBounds();
      await this._loadDeliveries();
    };
    searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') v.querySelector('#dGo').click(); });
    v.querySelector('#dCsv').onclick = () => this._csv('deliveries');
    v.querySelector('#dPrint').onclick = () => this._printDeliveries();
    const showBtn = v.querySelector('#dShowRecords');
    if (showBtn) {
      showBtn.onclick = () => {
        const wrap = v.querySelector('#dRecordsWrap');
        const willOpen = wrap.hidden;
        wrap.hidden = !willOpen;
        showBtn.setAttribute('aria-expanded', String(willOpen));
        showBtn.textContent = willOpen ? 'Hide records' : 'Show records';
        if (willOpen && this.dData) this._renderDeliveryTable();
      };
    }
  },

  _deliveryFilterLabel() {
    let label = 'All restock records';
    if (this.dFrom && this.dTo) label = `${this.dFrom} to ${this.dTo}`;
    else if (this.dFrom) label = `From ${this.dFrom}`;
    else if (this.dTo) label = `Through ${this.dTo}`;
    return this.dQ ? `${label} · matching “${this.dQ}”` : label;
  },

  async _loadDeliveries() {
    const pane = this.viewEl.querySelector('#rDelivery');
    const applyButton = pane && pane.querySelector('#dGo');
    if (pane) pane.setAttribute('aria-busy', 'true');
    if (applyButton) { applyButton.disabled = true; applyButton.textContent = 'Loading…'; }
    const f = {
      from: this.dFrom || undefined,
      to: this.dTo || undefined,
      q: this.dQ || undefined,
    };
    try {
      const [list, summary] = await Promise.all([
        App.pos.deliveries.list(f),
        App.pos.deliveries.summary(f),
      ]);
      this.dData = { list, summary };
      this._renderDelivery();
    } catch (e) {
      App.ui.toast(e.message || 'Unable to load restock history', 'err');
      const summary = pane && pane.querySelector('#dRecordsSummary');
      if (summary) summary.textContent = 'Restock history could not be loaded.';
    } finally {
      if (pane) pane.setAttribute('aria-busy', 'false');
      if (applyButton) { applyButton.disabled = false; applyButton.textContent = 'Apply filters'; }
    }
  },

  _renderDelivery() {
    if (this.tab !== 'delivery') return;
    if (!this.viewEl.querySelector('#dRecordsWrap')) { this._renderDeliveryShell(); }
    const d = this.dData; const v = this.viewEl.querySelector('#rDelivery');
    const s = d.summary || {};
    const totals = s.totals || {};
    const top = s.top || null;
    const period = v.querySelector('#dPeriodLabel');
    if (period) period.textContent = this._deliveryFilterLabel();
    const clearButton = v.querySelector('#dClear');
    if (clearButton) clearButton.disabled = !this.dFrom && !this.dTo && !this.dQ;
    v.querySelector('#dStats').innerHTML = `
      <article class="stat report-stat">
        <div class="k">Total Restocks</div>
        <div class="v">${totals.tx || 0}</div>
        <small class="muted">delivery events logged</small>
      </article>
      <article class="stat report-stat">
        <div class="k">Units Received</div>
        <div class="v">${App.ui.qty(totals.units || 0)}</div>
        <small class="muted">total quantity added</small>
      </article>
      <article class="stat report-stat">
        <div class="k">Products Restocked</div>
        <div class="v">${s.products || 0}</div>
        <small class="muted">distinct items restocked</small>
      </article>
      <article class="stat report-stat">
        <div class="k">Top Restocked</div>
        <div class="v report-stat-name">${top ? App.ui.esc(top.name) : '—'}</div>
        <small class="muted">${top ? '+' + App.ui.qty(top.qty) + ' units' : 'no data'}</small>
      </article>`;

    const rows = d.list || [];
    const recordsSummary = v.querySelector('#dRecordsSummary');
    if (recordsSummary) recordsSummary.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'} · ${this._deliveryFilterLabel()}`;
    const showBtn = v.querySelector('#dShowRecords');
    if (showBtn) showBtn.textContent = showBtn.getAttribute('aria-expanded') === 'true' ? `Hide records (${rows.length})` : `Show records (${rows.length})`;
    const wrap = v.querySelector('#dRecordsWrap');
    if (wrap && !wrap.hidden) this._renderDeliveryTable();
  },

  _renderDeliveryTable() {
    const d = this.dData; if (!d) return;
    const v = this.viewEl.querySelector('#rDelivery');
    const wrap = v.querySelector('#dRecordsWrap');
    if (!wrap) return;
    const rows = d.list || [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty-state muted">No restocks in this period</div>';
      return;
    }
    wrap.innerHTML = `<div style="overflow:auto;max-height:560px"><table class="tbl"><thead><tr>
        <th>Date / Time</th><th>SKU</th><th>Product</th><th>Category</th><th class="right">Qty Added</th><th>Unit</th><th>Type</th><th>Reason</th><th>Location</th><th>Restocked By</th>
      </tr></thead><tbody>
      ${rows.map((r) => {
        const typeBadge = r.movement === 'restock'
          ? '<span class="badge" style="background:#e6f0fa;color:#1a4a7a">Initial</span>'
          : '<span class="badge" style="background:#e6f4ea;color:#1a7a32">Restock</span>';
        return `<tr>
          <td>${App.ui.fmtDate(r.datetime)}</td>
          <td class="mono">${App.ui.esc(r.sku || '—')}</td>
          <td>${App.ui.esc(r.name || '(deleted product)')}</td>
          <td>${App.ui.esc(r.category_name || '—')}</td>
          <td class="right" style="color:#1a7a32;font-weight:700">+${App.ui.qty(r.qty_change)}</td>
          <td>${App.ui.esc(r.base_unit || '')}</td>
          <td>${typeBadge}</td>
          <td>${App.ui.esc(r.reason || '—')}</td>
          <td>${App.ui.esc(r.source_location || '—')}</td>
          <td>${App.ui.esc(r.user_name || '—')}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  },

  _printDeliveries() {
    const d = this.dData; if (!d) return;
    const rows = d.list || [];
    const s = d.summary || {};
    const totals = s.totals || {};
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>YANKENT POS — Stock &amp; Restock History</title>
      <style>body{font-family:Segoe UI,sans-serif;padding:24px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:11px}th,td{border:1px solid #ddd;padding:5px 8px;text-align:left}th{background:#f4f4f5}.r{text-align:right}.pos{color:#1a7a32;font-weight:700}</style></head>
      <body><h1>YANKENT POS — Stock &amp; Restock History</h1>
      <div style="color:#666;font-size:12px">Generated ${new Date().toLocaleString()}</div>
      <p>Total restocks: <b>${totals.tx || 0}</b> · Units received: <b>${App.ui.qty(totals.units || 0)}</b> · Products restocked: <b>${s.products || 0}</b></p>
      <table><tr><th>Date / Time</th><th>SKU</th><th>Product</th><th class="r">Qty Added</th><th>Unit</th><th>Reason</th><th>Location</th><th>Restocked By</th></tr>
      ${rows.map((r) => `<tr><td>${App.ui.fmtDate(r.datetime)}</td><td>${App.ui.esc(r.sku||'—')}</td><td>${App.ui.esc(r.name||'(deleted)')}</td><td class="r pos">+${App.ui.qty(r.qty_change)}</td><td>${App.ui.esc(r.base_unit||'')}</td><td>${App.ui.esc(r.reason||'—')}</td><td>${App.ui.esc(r.source_location||'—')}</td><td>${App.ui.esc(r.user_name||'—')}</td></tr>`).join('')}
      </table></body></html>`;
    App.pos.printer.printHtml(html).catch((e) => App.ui.toast(e.message, 'err'));
  },

  // ===== Shared ===========================================================
  async _csv(type) {
    // The Restock History tab has its own date filters (dFrom/dTo); the
    // Sales Reports tab uses from/to.  Pass the right range per tab/type.
    const f = type === 'deliveries'
      ? { from: this.dFrom || undefined, to: this.dTo || undefined }
      : { from: this.from || undefined, to: this.to || undefined };
    try { const p = await App.pos.reports.exportCSV(type, f); if (p) App.ui.toast('Exported: ' + p, 'ok'); }
    catch (e) { App.ui.toast(e.message, 'err'); }
  },

  async _resetSales() {
    const ok = await App.ui.confirm(
      'This will PERMANENTLY erase ALL sales, sale items, refunds and stock movements.\n\nUsers, products, customers, categories and settings will be preserved. Product stock will be reset to 0.\n\nThis cannot be undone. Consider exporting a backup first.\n\nContinue?',
      { danger: true, title: 'Reset all sales' }
    );
    if (!ok) return;
    const ok2 = await App.ui.confirm('Are you absolutely sure? Type-confirm again to erase all sales data.', { danger: true, title: 'Final confirmation' });
    if (!ok2) return;
    try {
      await App.pos.sales.reset();
      App.ui.toast('All sales data reset ✓', 'ok');
      await this._load();
    } catch (e) { App.ui.toast(e.message, 'err'); }
  },

  _print() {
    const d = this.data; const s = d.summary;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>YANKENT POS Report</title>
      <style>body{font-family:Segoe UI,sans-serif;padding:24px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:12px}th,td{border:1px solid #ddd;padding:5px 8px;text-align:left}th{background:#f4f4f5}.r{text-align:right}</style></head>
      <body><h1>YANKENT POS — Sales Report</h1><div style="color:#666;font-size:12px">Generated ${new Date().toLocaleString()}</div>
      <p>Today: <b>${App.ui.money(s.today.total)}</b> / ${s.today.tx} transactions<br>
      Yesterday: <b>${App.ui.money(s.yesterday.total)}</b> / ${s.yesterday.tx} transactions<br>
      This Month: <b>${App.ui.money(s.month.total)}</b> / ${s.month.tx} tx<br>
      This Year: <b>${App.ui.money(s.year.total)}</b> / ${s.year.tx} tx<br>
      Best Day: <b>${s.bestDay ? App.ui.money(s.bestDay.total) + ' (' + s.bestDay.label + ')' : '—'}</b></p>
      <h3>Best-selling</h3><table><tr><th>Item</th><th class="r">Qty</th><th class="r">Total</th></tr>${d.best.map((b) => `<tr><td>${b.name}</td><td class="r">${App.ui.qty(b.qty)}</td><td class="r">${App.ui.money(b.total)}</td></tr>`).join('')}</table>
      <h3>By cashier</h3><table><tr><th>Cashier</th><th class="r">Tx</th><th class="r">Total</th></tr>${d.csr.map((c) => `<tr><td>${c.cashier_name}</td><td class="r">${c.tx}</td><td class="r">${App.ui.money(c.total)}</td></tr>`).join('')}</table>
      </body></html>`;
    App.pos.printer.printHtml(html).catch((e) => App.ui.toast(e.message, 'err'));
  },
};


// ===== Expenses & ROI =====================================================
// Administrator-only financial view. Inventory expense is a live valuation
// (stock on hand × current cost); historical ROI is explicitly estimated
// because sale lines do not store a cost snapshot.
App.views.expenses = {
  title: 'Expenses & ROI',
  viewEl: null,
  data: null,
  from: '',
  to: '',
  query: '',
  productFilter: 'all',
  productSort: 'inventory',
  requestId: 0,

  async render(view) {
    this.viewEl = view;
    view.classList.add('view-expenses');
    view.innerHTML = `
      <div class="reports-page roi-page">
        <header class="reports-header roi-header">
          <div class="reports-heading">
            <div class="reports-eyebrow">Financial intelligence</div>
            <h2>Expenses &amp; ROI</h2>
            <p>See current inventory investment, sales return, estimated product costs, and profitability in one place.</p>
          </div>
          <div class="reports-actions">
            <span class="roi-updated" id="roiUpdated" aria-live="polite">Loading latest figures…</span>
            <button type="button" class="btn btn-sm btn-ghost" id="roiRefresh">Refresh</button>
          </div>
        </header>

        <section class="report-filter-panel roi-filter-panel" aria-labelledby="roiFilterTitle">
          <div class="report-filter-summary">
            <span id="roiFilterTitle">Sales period</span>
            <strong id="roiPeriodLabel" aria-live="polite">${App.ui.esc(this._periodLabel())}</strong>
            <small>Inventory expense always reflects stock on hand now.</small>
          </div>
          <div class="report-filter-fields">
            <div class="report-date-field"><label class="fl" for="roiFrom">From</label><input id="roiFrom" type="date" value="${App.ui.esc(this.from)}"></div>
            <div class="report-date-field"><label class="fl" for="roiTo">To</label><input id="roiTo" type="date" value="${App.ui.esc(this.to)}"></div>
            <button type="button" class="btn btn-primary btn-sm" id="roiApply">Apply range</button>
            <button type="button" class="btn btn-sm btn-ghost" data-roi-preset="all">All time</button>
            <button type="button" class="btn btn-sm btn-ghost" data-roi-preset="month">This month</button>
            <button type="button" class="btn btn-sm btn-ghost" data-roi-preset="year">This year</button>
          </div>
        </section>

        <div class="reports-section-heading">
          <div><h3>Financial overview</h3><p>ROI uses completed physical-product sales only; refund activity follows the date each refund was processed.</p></div>
        </div>
        <div class="stat-grid roi-stat-grid" id="roiStats" aria-busy="true">
          <article class="stat report-stat"><div class="k">Loading</div><div class="v"><span class="spinner"></span></div></article>
        </div>
        <div id="roiCostNotice" class="roi-notice" aria-live="polite"></div>

        <div class="roi-insight-grid">
          <section class="roi-insight-card" aria-labelledby="roiFlowTitle">
            <div class="roi-card-heading"><div><h3 id="roiFlowTitle">Product return</h3><p>VAT-exclusive physical-product sales compared with estimated product cost.</p></div></div>
            <div id="roiFlow" class="roi-flow"></div>
          </section>
          <section class="roi-insight-card roi-method-card" aria-labelledby="roiMethodTitle">
            <div class="roi-card-heading"><div><h3 id="roiMethodTitle">How ROI is calculated</h3><p>Simple, transparent calculations based on your POS records.</p></div></div>
            <div class="roi-formula"><span>Product gross profit</span><strong>Product sales (ex VAT) − estimated product COGS</strong></div>
            <div class="roi-formula"><span>Product ROI</span><strong>Product gross profit ÷ estimated product COGS × 100</strong></div>
            <p class="roi-method-note">ROI excludes service and delivery revenue so it is compared only with physical-product cost. COGS uses each product’s <b>current cost</b> because older sales do not contain cost snapshots. For like-for-like VAT reporting, enter cost excluding recoverable input VAT.</p>
          </section>
        </div>

        <section class="roi-products-panel" aria-labelledby="roiProductsTitle">
          <div class="roi-products-head">
            <div>
              <h3 id="roiProductsTitle">Product expense &amp; return</h3>
              <p id="roiProductsSummary">Loading product costs…</p>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" id="roiManageCosts">Manage product costs</button>
          </div>
          <div class="roi-product-toolbar">
            <div class="roi-search-field"><label class="fl" for="roiProductSearch">Search products</label><input id="roiProductSearch" type="search" value="${App.ui.esc(this.query)}" placeholder="Name, SKU, category…"></div>
            <div><label class="fl" for="roiProductFilter">Show</label><select id="roiProductFilter">
              <option value="all">All physical products</option>
              <option value="stock">Products in stock</option>
              <option value="sold">Sold in this period</option>
              <option value="missing">Missing cost data</option>
            </select></div>
            <div><label class="fl" for="roiProductSort">Sort by</label><select id="roiProductSort">
              <option value="inventory">Highest inventory expense</option>
              <option value="profit">Highest gross profit</option>
              <option value="sales">Highest net sales</option>
              <option value="roi">Highest ROI</option>
              <option value="name">Product name</option>
            </select></div>
          </div>
          <div class="roi-table-wrap" tabindex="0" role="region" aria-label="Scrollable product expense and return table">
            <table class="tbl roi-table">
              <thead><tr>
                <th>Product</th><th class="right">Stock</th><th class="right">Unit cost</th>
                <th class="right">Inventory expense</th><th class="right">Base units sold</th>
                <th class="right">Net sales</th><th class="right">Est. COGS</th>
                <th class="right">Gross profit</th><th class="right">ROI</th>
              </tr></thead>
              <tbody id="roiProductRows"><tr><td colspan="9"><div class="empty-state"><span class="spinner"></span> Loading products…</div></td></tr></tbody>
            </table>
          </div>
        </section>
      </div>`;
    this._wire();
    await this._load();
  },

  destroy() {
    this.requestId += 1;
    this.data = null;
    if (this.viewEl) {
      this.viewEl.classList.remove('view-expenses');
      this.viewEl.innerHTML = '';
    }
    this.viewEl = null;
  },

  _wire() {
    const view = this.viewEl;
    const fromEl = view.querySelector('#roiFrom');
    const toEl = view.querySelector('#roiTo');
    const syncBounds = () => { toEl.min = fromEl.value || ''; fromEl.max = toEl.value || ''; };
    fromEl.addEventListener('change', syncBounds);
    toEl.addEventListener('change', syncBounds);
    syncBounds();

    view.querySelector('#roiApply').onclick = () => this._applyRange(fromEl.value, toEl.value);
    view.querySelectorAll('[data-roi-preset]').forEach((button) => {
      button.onclick = () => this._applyPreset(button.dataset.roiPreset, fromEl, toEl);
    });
    view.querySelector('#roiRefresh').onclick = () => this._load();

    const searchEl = view.querySelector('#roiProductSearch');
    const filterEl = view.querySelector('#roiProductFilter');
    const sortEl = view.querySelector('#roiProductSort');
    view.querySelector('#roiManageCosts').onclick = () => this._showMissingCosts();
    view.querySelector('#roiProductRows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-cost]');
      if (!button) return;
      const product = this.data && this.data.products.find((row) => row.id === Number(button.dataset.editCost));
      if (product) this._editCost(product);
    });

    filterEl.value = this.productFilter;
    sortEl.value = this.productSort;
    searchEl.addEventListener('input', App.ui.debounce(() => {
      this.query = searchEl.value;
      this._renderProductRows();
    }, 120));
    filterEl.addEventListener('change', () => {
      this.productFilter = filterEl.value;
      this._renderProductRows();
    });
    sortEl.addEventListener('change', () => {
      this.productSort = sortEl.value;
      this._renderProductRows();
    });
  },

  _showMissingCosts() {
    if (!this.viewEl) return;
    this.productFilter = 'missing';
    this.query = '';
    const filter = this.viewEl.querySelector('#roiProductFilter');
    const search = this.viewEl.querySelector('#roiProductSearch');
    if (filter) filter.value = 'missing';
    if (search) search.value = '';
    this._renderProductRows();
    this.viewEl.querySelector('.roi-products-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (search) search.focus();
  },

  _editCost(product) {
    const generation = App.captureSessionGeneration();
    const m = App.ui.modal({
      title: 'Update Product Cost',
      closeOnOverlay: false,
      bodyHtml: `<div class="roi-cost-product"><b>${App.ui.esc(product.name)}</b><span>${App.ui.esc(product.sku)} · ${App.ui.esc(product.category)}${product.active ? '' : ' · Inactive'}</span></div>
        <div class="field"><label class="fl" for="roiCostInput">Current cost per ${App.ui.esc(product.base_unit)}</label><input id="roiCostInput" type="number" min="0" step="0.01" value="${Number(product.unit_cost || 0).toFixed(2)}" aria-describedby="roiCostHint" autofocus></div>
        <div class="hint" id="roiCostHint">This current cost updates inventory expense and estimates COGS for past sales. If input VAT is recoverable, enter the VAT-exclusive cost.</div>`,
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-primary" data-a="save">Save cost</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    const save = async () => {
      const input = m.el.querySelector('#roiCostInput');
      const rawValue = input.value.trim();
      if (!rawValue) {
        App.ui.toast('Cost is required; enter 0 only when the product truly has no cost', 'err');
        input.focus();
        return;
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) {
        App.ui.toast('Cost must be a non-negative number', 'err');
        input.focus();
        return;
      }
      const button = m.el.querySelector('[data-a="save"]');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await App.pos.products.setCost(product.id, value);
        if (!App.isSessionGenerationCurrent(generation)) return;
        m.close();
        App.ui.toast(`Cost updated for ${product.name}`, 'ok');
        await this._load();
      } catch (error) {
        if (error.code === 'SESSION_EXPIRED') {
          document.getElementById('logoutBtn').click();
          return;
        }
        if (!App.isSessionGenerationCurrent(generation)) return;
        App.ui.toast(error.message, 'err');
        button.disabled = false;
        button.textContent = 'Save cost';
      }
    };
    m.el.querySelector('[data-a="save"]').onclick = save;
    m.el.querySelector('#roiCostInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); save(); }
    });
  },

  async _applyRange(from, to) {
    if (from && to && from > to) {
      App.ui.toast('The From date must be earlier than or equal to the To date', 'err');
      this.viewEl.querySelector('#roiFrom').focus();
      return;
    }
    this.from = from;
    this.to = to;
    await this._load();
  },

  async _applyPreset(preset, fromEl, toEl) {
    const today = new Date();
    if (preset === 'all') {
      this.from = '';
      this.to = '';
    } else if (preset === 'month') {
      this.from = this._dateText(new Date(today.getFullYear(), today.getMonth(), 1));
      this.to = this._dateText(today);
    } else if (preset === 'year') {
      this.from = this._dateText(new Date(today.getFullYear(), 0, 1));
      this.to = this._dateText(today);
    }
    fromEl.value = this.from;
    toEl.value = this.to;
    toEl.min = this.from;
    fromEl.max = this.to;
    await this._load();
  },

  _dateText(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  _periodLabel() {
    if (this.from && this.to) return `${this.from} to ${this.to}`;
    if (this.from) return `From ${this.from}`;
    if (this.to) return `Through ${this.to}`;
    return 'All recorded sales';
  },

  async _load() {
    const view = this.viewEl;
    if (!view) return;
    const requestId = ++this.requestId;
    const generation = App.captureSessionGeneration();
    const isCurrent = () => (
      requestId === this.requestId &&
      this.viewEl === view &&
      App.current.view === 'expenses' &&
      view.isConnected &&
      App.isSessionGenerationCurrent(generation)
    );
    const apply = view.querySelector('#roiApply');
    const refresh = view.querySelector('#roiRefresh');
    const stats = view.querySelector('#roiStats');
    view.setAttribute('aria-busy', 'true');
    if (stats) stats.setAttribute('aria-busy', 'true');
    if (apply) { apply.disabled = true; apply.textContent = 'Loading…'; }
    if (refresh) refresh.disabled = true;
    try {
      const data = await App.pos.reports.expensesRoi({
        from: this.from || undefined,
        to: this.to || undefined,
      });
      if (!isCurrent()) return;
      this.data = data;
      this._render();
      const updated = view.querySelector('#roiUpdated');
      if (updated) updated.textContent = `Updated ${new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') {
        if (requestId === this.requestId && this.viewEl === view && App.isSessionGenerationCurrent(generation)) {
          App.ui.toast('Session expired — please log in again', 'err');
          document.getElementById('logoutBtn')?.click();
        }
        return;
      }
      if (!isCurrent()) return;
      this.data = null;
      App.ui.toast(error.message || 'Unable to calculate expenses and ROI', 'err');
      if (stats) stats.innerHTML = '<div class="report-error" role="alert">Expenses and ROI could not be calculated. Check the database and try again.</div>';
      const notice = view.querySelector('#roiCostNotice');
      if (notice) { notice.className = 'roi-notice'; notice.innerHTML = ''; }
      const flow = view.querySelector('#roiFlow');
      if (flow) flow.innerHTML = '<div class="report-error" role="alert">Product return details are unavailable.</div>';
      const rows = view.querySelector('#roiProductRows');
      if (rows) rows.innerHTML = '<tr><td colspan="9"><div class="empty-state">Product expense data could not be loaded.</div></td></tr>';
      const productsSummary = view.querySelector('#roiProductsSummary');
      if (productsSummary) productsSummary.textContent = 'Product costs are unavailable.';
      const updated = view.querySelector('#roiUpdated');
      if (updated) updated.textContent = 'Update failed';
    } finally {
      if (isCurrent()) {
        view.setAttribute('aria-busy', 'false');
        if (stats) stats.setAttribute('aria-busy', 'false');
        if (apply) { apply.disabled = false; apply.textContent = 'Apply range'; }
        if (refresh) refresh.disabled = false;
      }
    }
  },

  _render() {
    if (!this.data || !this.viewEl) return;
    const summary = this.data.summary;
    const periodLabel = this._periodLabel();
    this.viewEl.querySelector('#roiPeriodLabel').textContent = periodLabel;
    const roiClass = summary.roi_percent == null ? '' : (summary.roi_percent >= 0 ? 'positive' : 'negative');
    const profitClass = summary.gross_profit >= 0 ? 'positive' : 'negative';
    const transactionCount = Number(summary.completed_transactions || 0) + Number(summary.refunded_transactions || 0);
    const refundActivity = Number(summary.refund_activity_total || 0);
    this.viewEl.querySelector('#roiStats').innerHTML = `
      ${this._statCard('Current inventory expense', App.ui.money(summary.inventory_expense), `${summary.products_with_stock} stocked product${summary.products_with_stock === 1 ? '' : 's'} · all current stock`, 'expense')}
      ${this._statCard('Gross POS sales', App.ui.money(summary.gross_sales), `${transactionCount} original transaction${transactionCount === 1 ? '' : 's'} in this sales period · before full-sale refunds`)}
      ${this._statCard('Refund activity', App.ui.money(refundActivity), `${summary.refund_activity_transactions} refund${summary.refund_activity_transactions === 1 ? '' : 's'} processed in this period · shown separately from ROI`, refundActivity > 0 ? 'negative' : '')}
      ${this._statCard('Product sales (ex VAT)', App.ui.money(summary.product_net_sales), 'Completed physical-product sales only · services and delivery excluded')}
      ${this._statCard('Estimated product COGS', App.ui.money(summary.estimated_cogs), 'Current physical-product cost × base units sold', 'expense')}
      ${this._statCard('Product gross profit', App.ui.money(summary.gross_profit), 'Product sales excluding VAT − estimated product COGS', profitClass)}
      ${this._statCard('Estimated product ROI', this._percent(summary.roi_percent), 'Product gross profit ÷ estimated product COGS', roiClass)}
      ${this._statCard('Product gross margin', this._percent(summary.margin_percent), 'Product gross profit as a share of product sales', profitClass)}`;

    const missingStock = Number(summary.products_without_cost || 0);
    const missingSold = Number(summary.sold_without_cost_count || 0);
    const notice = this.viewEl.querySelector('#roiCostNotice');
    if (missingStock || missingSold) {
      notice.className = 'roi-notice warning';
      notice.innerHTML = `<div><b>Cost data needs attention</b><span>${missingStock} stocked product${missingStock === 1 ? '' : 's'} and ${missingSold} sold product${missingSold === 1 ? '' : 's'} have no cost. Inventory expense and estimated COGS may be understated; profit and ROI may be overstated or unavailable.</span></div><button type="button" class="btn btn-sm btn-ghost" id="roiFixCosts">Review missing costs</button>`;
      notice.querySelector('#roiFixCosts').onclick = () => this._showMissingCosts();
    } else {
      notice.className = 'roi-notice ok';
      notice.innerHTML = `<div><b>Product cost coverage: ${this._percent(summary.inventory_cost_coverage_percent)}</b><span>Every stocked or sold physical product has a current cost for these estimates.</span></div>`;
    }

    const flowMax = Math.max(Number(summary.product_net_sales || 0), Number(summary.estimated_cogs || 0), Math.abs(Number(summary.gross_profit || 0)), 1);
    const flowRows = [
      { label: 'Product sales (ex VAT)', value: summary.product_net_sales, className: 'sales' },
      { label: 'Estimated product COGS', value: summary.estimated_cogs, className: 'cost' },
      { label: 'Product gross profit', value: summary.gross_profit, className: summary.gross_profit >= 0 ? 'profit' : 'loss' },
    ];
    this.viewEl.querySelector('#roiFlow').innerHTML = flowRows.map((row) => {
      const width = Math.max(2, Math.round((Math.abs(Number(row.value || 0)) / flowMax) * 100));
      return `<div class="roi-flow-row"><div class="roi-flow-label"><span>${row.label}</span><strong>${App.ui.money(row.value)}</strong></div><div class="roi-flow-track"><span class="roi-flow-bar ${row.className}" style="width:${width}%"></span></div></div>`;
    }).join('') + `<div class="roi-flow-context"><span>Excluded from product ROI (ex VAT)</span><strong>Services ${App.ui.money(summary.service_net_sales)} · Delivery ${App.ui.money(summary.delivery_net_sales)}</strong></div>`;

    this._renderProductRows();
  },

  _statCard(label, value, detail, className = '') {
    return `<article class="stat report-stat roi-stat ${className}"><div class="k">${label}</div><div class="v">${value}</div><small class="muted">${detail}</small></article>`;
  },

  _percent(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return `${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  },

  _filteredProducts() {
    const query = String(this.query || '').trim().toLowerCase();
    let rows = [...((this.data && this.data.products) || [])];
    if (query) {
      rows = rows.filter((row) => [row.name, row.sku, row.category, row.base_unit]
        .some((value) => String(value || '').toLowerCase().includes(query)));
    }
    if (this.productFilter === 'stock') rows = rows.filter((row) => Number(row.stock) > 0);
    if (this.productFilter === 'sold') rows = rows.filter((row) => Number(row.units_sold) > 0);
    if (this.productFilter === 'missing') rows = rows.filter((row) => row.missing_cost && (Number(row.stock) > 0 || Number(row.units_sold) > 0));

    const number = (value, fallback = 0) => {
      if (value === null || value === undefined || value === '') return fallback;
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    };
    const sorters = {
      inventory: (a, b) => number(b.inventory_expense) - number(a.inventory_expense),
      profit: (a, b) => number(b.gross_profit) - number(a.gross_profit),
      sales: (a, b) => number(b.net_sales) - number(a.net_sales),
      roi: (a, b) => number(b.roi_percent, -Infinity) - number(a.roi_percent, -Infinity),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    rows.sort(sorters[this.productSort] || sorters.inventory);
    return rows;
  },

  _renderProductRows(reset = true) {
    if (!this.data || !this.viewEl) return;
    const rows = this._filteredProducts();
    const body = this.viewEl.querySelector('#roiProductRows');
    if (!rows.length) {
      this._productRowsShown = 0;
      const summary = this.viewEl.querySelector('#roiProductsSummary');
      if (summary) summary.textContent = `0 of ${this.data.products.length} physical products · ${this._periodLabel()}`;
      body.innerHTML = '<tr><td colspan="9"><div class="empty-state">No products match these filters.</div></td></tr>';
      return;
    }

    const batchSize = 200;
    const previous = reset ? 0 : Number(this._productRowsShown || 0);
    const shown = Math.min(rows.length, reset ? batchSize : previous + batchSize);
    this._productRowsShown = shown;
    const summary = this.viewEl.querySelector('#roiProductsSummary');
    if (summary) {
      summary.textContent = `${rows.length} of ${this.data.products.length} physical products · showing ${shown} · ${this._periodLabel()}`;
    }

    const productRows = rows.slice(0, shown).map((row) => {
      const costRelevant = row.missing_cost && (Number(row.stock) > 0 || Number(row.units_sold) > 0);
      const profitClass = Number(row.gross_profit) > 0 ? 'roi-money-positive' : (Number(row.gross_profit) < 0 ? 'roi-money-negative' : '');
      const roiValue = row.roi_percent == null
        ? (Number(row.net_sales) > 0 && row.missing_cost ? '<span class="roi-cost-missing">Cost needed</span>' : '—')
        : this._percent(row.roi_percent);
      return `<tr class="${costRelevant ? 'roi-missing-cost-row' : ''}">
        <td><div class="roi-product-cell"><b>${App.ui.esc(row.name)}</b><span>${App.ui.esc(row.sku)} · ${App.ui.esc(row.category)}${row.active ? '' : ' · Inactive'}</span>${costRelevant ? '<em>Missing cost</em>' : ''}</div></td>
        <td class="right">${App.ui.qty(row.stock)} <small>${App.ui.esc(row.base_unit)}</small></td>
        <td class="right"><div class="roi-cost-cell"><span>${App.ui.money(row.unit_cost)}</span><button type="button" class="roi-cost-edit" data-edit-cost="${row.id}" aria-label="${row.missing_cost ? 'Set' : 'Edit'} unit cost for ${App.ui.esc(row.name)}">${row.missing_cost ? 'Set' : 'Edit'}</button></div></td>
        <td class="right"><b>${App.ui.money(row.inventory_expense)}</b></td>
        <td class="right">${App.ui.qty(row.units_sold)}</td>
        <td class="right">${App.ui.money(row.net_sales)}</td>
        <td class="right">${App.ui.money(row.estimated_cogs)}</td>
        <td class="right ${profitClass}">${App.ui.money(row.gross_profit)}</td>
        <td class="right ${profitClass}">${roiValue}</td>
      </tr>`;
    }).join('');
    const remaining = rows.length - shown;
    body.innerHTML = productRows + (remaining > 0
      ? `<tr class="roi-load-more-row"><td colspan="9"><button type="button" class="btn btn-sm btn-ghost" data-load-more>Load ${Math.min(batchSize, remaining)} more products</button><span>${shown} of ${rows.length} shown</span></td></tr>`
      : '');
    const loadMore = body.querySelector('[data-load-more]');
    if (loadMore) {
      loadMore.onclick = () => {
        const firstNewIndex = shown;
        this._renderProductRows(false);
        const firstNewCostButton = body.querySelectorAll('[data-edit-cost]')[firstNewIndex];
        const nextLoadMore = body.querySelector('[data-load-more]');
        (firstNewCostButton || nextLoadMore)?.focus();
      };
    }
  },
};
