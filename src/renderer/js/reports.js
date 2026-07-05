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
      <div class="tabs" id="rTabs">
        <div class="tab ${salesActive ? 'active' : ''}" data-tab="sales">Sales Reports</div>
        <div class="tab ${salesActive ? '' : 'active'}" data-tab="delivery">Stock &amp; Restock History</div>
      </div>
      <div id="rSales" class="tab-pane ${salesActive ? '' : 'hidden'}"></div>
      <div id="rDelivery" class="tab-pane ${salesActive ? 'hidden' : ''}"></div>`;
    view.querySelectorAll('#rTabs .tab').forEach((t) => t.onclick = () => this._switchTab(t.dataset.tab));
    await this._load();
  },

  _switchTab(tab) {
    this.tab = tab;
    const v = this.viewEl;
    v.querySelectorAll('#rTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
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
      <div class="toolbar">
        <label class="fl" style="margin:0">From</label><input id="rFrom" type="date" style="max-width:150px">
        <label class="fl" style="margin:0">To</label><input id="rTo" type="date" style="max-width:150px">
        <button class="btn btn-primary btn-sm" id="rGo">Apply</button>
        <button class="btn btn-sm btn-ghost" id="rClear" title="Clear date range">All time</button>
        <div class="fill"></div>
        <button class="btn btn-sm btn-ghost" id="rSendTg">📨 Telegram</button>
        <button class="btn btn-sm btn-ghost" id="rPrint">Print</button>
        <button class="btn btn-sm btn-danger" id="rReset" title="Erase all sales data (users, products, settings preserved)">Reset</button>
      </div>
      <div id="rStats" class="stat-grid"></div>
      <div class="collapse-list" id="rSections" style="margin-top:16px"></div>`;
    this._wireSales();
  },

  _wireSales() {
    const v = this.viewEl.querySelector('#rSales');
    v.querySelector('#rGo').onclick = () => { this.from = v.querySelector('#rFrom').value; this.to = v.querySelector('#rTo').value; this._loadSales(); };
    v.querySelector('#rClear').onclick = () => { this.from = ''; this.to = ''; v.querySelector('#rFrom').value = ''; v.querySelector('#rTo').value = ''; this._loadSales(); };
    v.querySelector('#rPrint').onclick = () => this._print();
    v.querySelector('#rReset').onclick = () => this._resetSales();
    v.querySelector('#rSendTg').onclick = async () => {
      const b = v.querySelector('#rSendTg'); b.disabled = true; b.textContent = '📨 Sending…';
      try { const r = await App.pos.telegram.sendReport(); r.ok ? App.ui.toast('Report sent ✓', 'ok') : App.ui.toast(r.error || 'Failed', 'err'); }
      catch (e) { App.ui.toast(e.message, 'err'); }
      b.disabled = false; b.textContent = '📨 Telegram';
    };
    // Click anywhere on a section header to toggle expand/collapse
    v.querySelector('#rSections').addEventListener('click', (e) => {
      const hdr = e.target.closest('.collapse-h');
      if (hdr) {
        const sec = hdr.parentElement;
        sec.classList.toggle('open');
        return;
      }
      // CSV button on a section header
      const csvBtn = e.target.closest('[data-x]');
      if (csvBtn) { this._csv(csvBtn.dataset.x); return; }
      // Reprint on recent sales row
      const txn = e.target.closest('[data-txn]')?.dataset.txn;
      if (txn) { App.printer.printReceiptFallback(txn).catch((err) => App.ui.toast(err.message, 'err')); }
    });
  },

  async _loadSales() {
    const f = { from: this.from || undefined, to: this.to || undefined };
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
  },

  _renderSales() {
    const d = this.data; const v = this.viewEl.querySelector('#rSales');
    const s = d.summary;
    const a = d.analytics || {};
    const rs = d.refundSummary || {};

    // ---- Summary stat cards (always visible) ---------------------------
    v.querySelector('#rStats').innerHTML = `
      <div class="stat">
        <div class="k">Today</div>
        <div class="v">${App.ui.money(s.today.total)}</div>
        <small class="muted">${s.today.tx} transaction${s.today.tx === 1 ? '' : 's'}</small>
      </div>
      <div class="stat">
        <div class="k">Yesterday</div>
        <div class="v">${App.ui.money(s.yesterday.total)}</div>
        <small class="muted">${s.yesterday.tx} transaction${s.yesterday.tx === 1 ? '' : 's'}</small>
      </div>
      <div class="stat">
        <div class="k">This Month</div>
        <div class="v">${App.ui.money(s.month.total)}</div>
        <small class="muted">${s.month.tx} transaction${s.month.tx === 1 ? '' : 's'}</small>
      </div>
      <div class="stat">
        <div class="k">This Year</div>
        <div class="v">${App.ui.money(s.year.total)}</div>
        <small class="muted">${s.year.tx} transaction${s.year.tx === 1 ? '' : 's'}</small>
      </div>`;

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
    const refundToday = rs.today || { tx: 0, total: 0 };

    // Build preview summaries (one line, muted) for each section header
    const sections = [
      {
        key: 'breakdown',
        title: "Today's Breakdown",
        preview: `Avg ${App.ui.money(avg)} · ${items} items · Best ${bestDay ? App.ui.money(bestDay.total) : '—'}`,
        csv: null,
        body: `<div class="kv">
          <div class="kv-row"><span class="kv-k">Avg. transaction</span><span class="kv-v">${App.ui.money(avg)}</span></div>
          <div class="kv-row"><span class="kv-k">Items sold</span><span class="kv-v">${items}</span></div>
          <div class="kv-row"><span class="kv-k">Best sales day</span><span class="kv-v">${bestDay ? App.ui.money(bestDay.total) : '—'}</span></div>
          <div class="kv-row"><span class="kv-k muted">${bestDay ? bestDay.label : 'no sales yet'}</span><span class="kv-v muted">${bestDay ? '↗ peak' : ''}</span></div>
        </div>`,
      },
      {
        key: 'payments',
        title: 'Payment Methods',
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
        preview: refundToday.tx ? `${refundToday.tx} today · ${App.ui.money(refundToday.total)}` : 'No refunds today',
        csv: 'refunds',
        body: refunds.length ? `<div style="overflow:auto;max-height:240px"><table class="tbl"><thead><tr><th>Refund ID</th><th>Original Txn</th><th>Date</th><th>Cashier</th><th class="right">Amount</th><th>Reason</th></tr></thead><tbody>
          ${refunds.map((r) => `<tr style="color:var(--danger)"><td class="mono">${App.ui.esc(r.refund_txn_id)}</td><td class="mono">${App.ui.esc(r.original_txn_id)}</td><td>${App.ui.fmtDate(r.datetime)}</td><td>${App.ui.esc(r.cashier_name)}</td><td class="right">${App.ui.money(r.total)}</td><td class="muted">${App.ui.esc(r.reason || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state muted">No refunds</div>',
      },
    ];

    // All sections start closed by default — the user clicks to open and
    // see the data.  Expand state is preserved across re-renders (e.g. when
    // changing the date range) so a section the user already opened stays
    // open after the data refreshes.
    const openDefaults = {};
    const container = v.querySelector('#rSections');
    const prevOpen = {};
    container.querySelectorAll('.collapse-section').forEach((s) => { prevOpen[s.dataset.key] = s.classList.contains('open'); });
    const isOpen = (k) => (k in prevOpen ? prevOpen[k] : openDefaults[k]);

    container.innerHTML = sections.map((s) => `<div class="collapse-section${isOpen(s.key) ? ' open' : ''}" data-key="${s.key}">
      <div class="collapse-h" role="button" tabindex="0">
        <div class="collapse-arrow">▸</div>
        <div class="collapse-info">
          <div class="collapse-title">${App.ui.esc(s.title)}</div>
          <div class="collapse-preview muted">${s.preview}</div>
        </div>
        ${s.csv ? `<button class="btn btn-sm btn-ghost" data-x="${s.csv}" title="Export CSV">CSV</button>` : ''}
      </div>
      <div class="collapse-b">${s.body}</div>
    </div>`).join('');
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
      <div class="toolbar">
        <label class="fl" style="margin:0">From</label><input id="dFrom" type="date" style="max-width:150px">
        <label class="fl" style="margin:0">To</label><input id="dTo" type="date" style="max-width:150px">
        <input id="dQ" type="search" placeholder="Search product, SKU, reason, location…" style="max-width:260px">
        <button class="btn btn-primary btn-sm" id="dGo">Apply</button>
        <div class="fill"></div>
        <button class="btn btn-sm btn-ghost" id="dCsv">CSV</button>
        <button class="btn btn-sm btn-ghost" id="dPrint">Print</button>
      </div>
      <div id="dStats" class="stat-grid"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary btn-sm" id="dShowRecords" style="margin-bottom:12px">▸ Show Records</button>
        <div id="dRecordsWrap" style="display:none"></div>
      </div>`;
    this._wireDelivery();
  },

  _wireDelivery() {
    const v = this.viewEl.querySelector('#rDelivery');
    v.querySelector('#dGo').onclick = () => {
      this.dFrom = v.querySelector('#dFrom').value;
      this.dTo = v.querySelector('#dTo').value;
      this.dQ = v.querySelector('#dQ').value;
      this._loadDeliveries();
    };
    v.querySelector('#dQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') v.querySelector('#dGo').click(); });
    v.querySelector('#dCsv').onclick = () => this._csv('deliveries');
    v.querySelector('#dPrint').onclick = () => this._printDeliveries();
    const showBtn = v.querySelector('#dShowRecords');
    if (showBtn) {
      showBtn.onclick = () => {
        const wrap = v.querySelector('#dRecordsWrap');
        const visible = wrap.style.display !== 'none';
        wrap.style.display = visible ? 'none' : 'block';
        showBtn.textContent = visible ? '▸ Show Records' : '▾ Hide Records';
        if (!visible && this.dData) this._renderDeliveryTable();
      };
    }
  },

  async _loadDeliveries() {
    const f = {
      from: this.dFrom || undefined,
      to: this.dTo || undefined,
      q: this.dQ || undefined,
    };
    const [list, summary] = await Promise.all([
      App.pos.deliveries.list(f),
      App.pos.deliveries.summary(f),
    ]);
    this.dData = { list, summary };
    this._renderDelivery();
  },

  _renderDelivery() {
    if (this.tab !== 'delivery') return;
    if (!this.viewEl.querySelector('#dRecordsWrap')) { this._renderDeliveryShell(); }
    const d = this.dData; const v = this.viewEl.querySelector('#rDelivery');
    const s = d.summary || {};
    const totals = s.totals || {};
    const top = s.top || null;
    v.querySelector('#dStats').innerHTML = `
      <div class="stat">
        <div class="k">Total Restocks</div>
        <div class="v">${totals.tx || 0}</div>
        <small class="muted">delivery events logged</small>
      </div>
      <div class="stat">
        <div class="k">Units Received</div>
        <div class="v">${App.ui.qty(totals.units || 0)}</div>
        <small class="muted">total quantity added</small>
      </div>
      <div class="stat">
        <div class="k">Products Restocked</div>
        <div class="v">${s.products || 0}</div>
        <small class="muted">distinct items restocked</small>
      </div>
      <div class="stat">
        <div class="k">Top Restocked</div>
        <div class="v" style="font-size:14px">${top ? App.ui.esc(top.name) : '—'}</div>
        <small class="muted">${top ? '+' + App.ui.qty(top.qty) + ' units' : 'no data'}</small>
      </div>`;

    const rows = d.list || [];
    const showBtn = v.querySelector('#dShowRecords');
    if (showBtn) {
      showBtn.textContent = (rows.length ? `▸ Show Records (${rows.length})` : '▸ Show Records');
    }
    const wrap = v.querySelector('#dRecordsWrap');
    if (wrap && wrap.style.display !== 'none') this._renderDeliveryTable();
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
