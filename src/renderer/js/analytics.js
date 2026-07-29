'use strict';
/* Analytics dashboard — simple, readable cards visible to all roles.
 * Separated from POS so cashiers see a clean sales summary without
 * the catalog/cart clutter.
 *
 * "Separate" toggles Utang (on-account) out of Sales overview totals
 * and shows Utang in its own section.
 */
window.App = window.App || {};
App.views = App.views || {};

App.views.analytics = {
  title: 'Analytics',
  viewEl: null,
  openState: { topSellers: true, refunds: false },
  separate: false,
  _cache: null,

  _readSeparatePref() {
    try {
      return localStorage.getItem('yankent-analytics-separate') === '1';
    } catch {
      return false;
    }
  },

  _writeSeparatePref(on) {
    try {
      localStorage.setItem('yankent-analytics-separate', on ? '1' : '0');
    } catch {}
  },

  async render(view) {
    this.viewEl = view;
    this.separate = this._readSeparatePref();
    view.classList.add('view-analytics');
    const role = App.current.user && App.current.user.role === 'admin' ? 'Administrator' : 'Cashier';
    view.innerHTML = `
      <div class="an-wrap">
        <header class="an-header">
          <div>
            <div class="an-eyebrow">${role} dashboard</div>
            <h2>Store performance</h2>
            <p>Monitor current sales activity, payment mix, products, and refunds.</p>
          </div>
          <div class="an-refresh-wrap">
            <span class="an-updated" id="anUpdated" aria-live="polite">Loading latest data…</span>
            <button type="button" class="btn btn-sm${this.separate ? ' btn-primary' : ' btn-ghost'}" id="anSeparate" aria-pressed="${this.separate ? 'true' : 'false'}" title="Keep Utang out of Sales totals">Separate</button>
            <button type="button" class="btn btn-sm btn-ghost" id="anRefresh">Refresh</button>
          </div>
        </header>
        <p class="an-separate-hint muted" id="anSeparateHint"></p>
        <div class="an-dashboard-groups" id="anCards" aria-busy="true">
          <section class="an-group" aria-labelledby="anSalesHeading">
            <div class="an-group-heading"><h3 id="anSalesHeading">Sales overview</h3><p id="anSalesSub">Rolling store totals and the best recorded day.</p></div>
            <div class="an-cards" id="anSalesCards"><div class="an-card muted">Loading…</div></div>
          </section>
          <section class="an-group" id="anUtangGroup" aria-labelledby="anUtangHeading" hidden>
            <div class="an-group-heading"><h3 id="anUtangHeading">Utang overview</h3><p>On-account sales only (not included in Sales above).</p></div>
            <div class="an-cards" id="anUtangCards"></div>
          </section>
          <section class="an-group" aria-labelledby="anOpsHeading">
            <div class="an-group-heading"><h3 id="anOpsHeading">Today’s operations</h3><p>Transaction quality, payment mix, and refund activity.</p></div>
            <div class="an-cards" id="anOpsCards"><div class="an-card muted">Loading…</div></div>
          </section>
        </div>
        <section class="an-group" aria-labelledby="anDetailHeading">
          <div class="an-group-heading"><h3 id="anDetailHeading">Activity details</h3><p>Open a section for item-level information.</p></div>
          <div class="collapse-list an-sections" id="anSections"></div>
        </section>
      </div>`;
    view.querySelector('#anRefresh').onclick = async () => {
      const button = view.querySelector('#anRefresh');
      button.disabled = true; button.textContent = 'Refreshing…';
      await this._load();
      button.disabled = false; button.textContent = 'Refresh';
    };
    view.querySelector('#anSeparate').onclick = () => {
      this.separate = !this.separate;
      this._writeSeparatePref(this.separate);
      this._syncSeparateButton();
      if (this._cache) this._renderFromCache(this._cache);
      else this._load();
    };
    view.querySelector('#anSections').addEventListener('click', (e) => {
      const toggle = e.target.closest('.collapse-toggle');
      if (!toggle) return;
      const sec = toggle.closest('.collapse-section');
      const key = sec.dataset.key;
      const open = !sec.classList.contains('open');
      this._setSectionOpen(sec, open);
      this.openState[key] = open;
    });
    this._syncSeparateButton();
    await this._load();
  },

  _syncSeparateButton() {
    const btn = this.viewEl.querySelector('#anSeparate');
    const hint = this.viewEl.querySelector('#anSeparateHint');
    if (btn) {
      btn.classList.toggle('btn-primary', this.separate);
      btn.classList.toggle('btn-ghost', !this.separate);
      btn.setAttribute('aria-pressed', this.separate ? 'true' : 'false');
    }
    if (hint) {
      hint.textContent = this.separate
        ? 'Separate is on — Sales totals exclude Utang (on-account). Utang is shown below.'
        : 'Tip: click Separate to keep Utang out of Sales totals.';
    }
  },

  _setSectionOpen(section, open) {
    section.classList.toggle('open', open);
    const toggle = section.querySelector('.collapse-toggle');
    const body = section.querySelector('.collapse-b');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (body) body.hidden = !open;
  },

  _periodCards(bucket, best) {
    const today = bucket.today || { tx: 0, total: 0 };
    const yesterday = bucket.yesterday || { tx: 0, total: 0 };
    const week = bucket.week || { tx: 0, total: 0 };
    const month = bucket.month || { tx: 0, total: 0 };
    const year = bucket.year || { tx: 0, total: 0 };
    return `
      <div class="an-card an-card-accent">
        <div class="an-k">Today</div>
        <div class="an-v">${App.ui.money(today.total)}</div>
        <div class="an-sub">${today.tx} transactions</div>
      </div>
      <div class="an-card">
        <div class="an-k">Yesterday</div>
        <div class="an-v">${App.ui.money(yesterday.total)}</div>
        <div class="an-sub">${yesterday.tx} transactions</div>
      </div>
      <div class="an-card">
        <div class="an-k">This Week</div>
        <div class="an-v">${App.ui.money(week.total)}</div>
        <div class="an-sub">${week.tx} transactions</div>
      </div>
      <div class="an-card">
        <div class="an-k">This Month</div>
        <div class="an-v">${App.ui.money(month.total)}</div>
        <div class="an-sub">${month.tx} transactions</div>
      </div>
      <div class="an-card">
        <div class="an-k">This Year</div>
        <div class="an-v">${App.ui.money(year.total)}</div>
        <div class="an-sub">${year.tx} transactions</div>
      </div>
      ${best !== undefined ? `
      <div class="an-card">
        <div class="an-k">Best Day</div>
        <div class="an-v">${best ? App.ui.money(best.total) : '—'}</div>
        <div class="an-sub">${best ? App.ui.esc(best.label) : ''}</div>
      </div>` : ''}`;
  },

  async _load() {
    const cardsEl = this.viewEl.querySelector('#anCards');
    cardsEl.setAttribute('aria-busy', 'true');
    try {
      const [summary, analytics, refunds, refundSummary] = await Promise.all([
        App.pos.reports.summary(),
        App.pos.reports.analytics(),
        App.pos.refunds.list({ limit: 100 }),
        App.pos.refunds.summary(),
      ]);
      this._cache = { summary, analytics, refunds, refundSummary };
      this._renderFromCache(this._cache);
    } catch (e) {
      this._cache = null;
      this.viewEl.querySelector('#anSalesCards').innerHTML = '<div class="an-card muted">Analytics unavailable.</div>';
      this.viewEl.querySelector('#anOpsCards').innerHTML = '';
      this.viewEl.querySelector('#anSections').innerHTML = `<div class="an-muted">${App.ui.esc(e.message)}</div>`;
      const updated = this.viewEl.querySelector('#anUpdated');
      if (updated) updated.textContent = 'Unable to refresh';
    } finally {
      cardsEl.setAttribute('aria-busy', 'false');
    }
  },

  _renderFromCache(cache) {
    const { summary: s, analytics: aRaw, refunds, refundSummary } = cache;
    const a = aRaw || {};
    const salesCardsEl = this.viewEl.querySelector('#anSalesCards');
    const utangGroup = this.viewEl.querySelector('#anUtangGroup');
    const utangCardsEl = this.viewEl.querySelector('#anUtangCards');
    const opsCardsEl = this.viewEl.querySelector('#anOpsCards');
    const sectionsEl = this.viewEl.querySelector('#anSections');
    const salesSub = this.viewEl.querySelector('#anSalesSub');

    const combined = {
      today: s.today || { tx: 0, total: 0 },
      yesterday: s.yesterday || { tx: 0, total: 0 },
      week: s.week || { tx: 0, total: 0 },
      month: s.month || { tx: 0, total: 0 },
      year: s.year || { tx: 0, total: 0 },
    };
    const sales = s.sales || combined;
    const utang = s.utang || {
      today: { tx: 0, total: 0 },
      yesterday: { tx: 0, total: 0 },
      week: { tx: 0, total: 0 },
      month: { tx: 0, total: 0 },
      year: { tx: 0, total: 0 },
    };

    const overview = this.separate ? sales : combined;
    const best = this.separate
      ? (sales.bestDay || null)
      : (s.bestDay || null);

    if (salesSub) {
      salesSub.textContent = this.separate
        ? 'Paid sales only (cash, card, e-wallet) — Utang excluded.'
        : 'All completed sales including Utang (on-account).';
    }

    salesCardsEl.innerHTML = this._periodCards(overview, best);

    if (utangGroup && utangCardsEl) {
      utangGroup.hidden = !this.separate;
      if (this.separate) {
        utangCardsEl.innerHTML = this._periodCards(utang);
      }
    }

    const todayForOps = this.separate
      ? (a.salesToday || sales.today || { tx: 0, total: 0 })
      : (a.today || combined.today);
    const avg = this.separate
      ? (a.avgTxSales != null ? a.avgTxSales : (todayForOps.tx > 0 ? todayForOps.total / todayForOps.tx : 0))
      : (todayForOps.tx > 0 ? a.avgTx : 0);
    const items = Math.round(
      this.separate ? (a.itemsSoldSales != null ? a.itemsSoldSales : 0) : (a.itemsSold || 0)
    );
    const paymentRows = this.separate ? (a.payBreakSales || []) : (a.payBreak || []);
    const pays = paymentRows.map((p) => {
      const label = p.payment_method === 'account' ? 'utang' : p.payment_method;
      return `${App.ui.esc(label)}: ${App.ui.money(p.total)}`;
    }).join(' · ') || '—';

    const rs = refundSummary || {};
    const refundToday = rs.today || { tx: 0, total: 0 };
    const refundMonth = rs.month || { tx: 0, total: 0 };

    opsCardsEl.innerHTML = `
      <div class="an-card">
        <div class="an-k">Avg. Transaction</div>
        <div class="an-v">${App.ui.money(avg)}</div>
        <div class="an-sub">${this.separate ? 'per paid sale today' : 'per sale today'}</div>
      </div>
      <div class="an-card">
        <div class="an-k">Items Sold Today</div>
        <div class="an-v">${items}</div>
        <div class="an-sub">${this.separate ? 'paid sales units' : 'units'}</div>
      </div>
      <div class="an-card">
        <div class="an-k">Payments Today</div>
        <div class="an-v an-v-sm">${pays}</div>
      </div>
      <div class="an-card" style="border-left:4px solid var(--danger)">
        <div class="an-k">Refunds Today</div>
        <div class="an-v" style="color:var(--danger)">${App.ui.money(refundToday.total)}</div>
        <div class="an-sub">${refundToday.tx} refund${refundToday.tx === 1 ? '' : 's'}</div>
      </div>
      <div class="an-card">
        <div class="an-k">Refunds This Month</div>
        <div class="an-v">${App.ui.money(refundMonth.total)}</div>
        <div class="an-sub">${refundMonth.tx} refund${refundMonth.tx === 1 ? '' : 's'}</div>
      </div>`;

    const tops = this.separate ? (a.topProductsSales || []) : (a.topProducts || []);
    const topPreview = tops.length
      ? `Top: ${App.ui.esc(tops[0].name)} (${App.ui.qty(tops[0].qty)} sold)`
      : 'No sales yet today';
    const topBody = tops.length
      ? `<table class="an-table">
          <thead><tr><th>#</th><th>Product</th><th class="right">Qty</th><th class="right">Total</th></tr></thead>
          <tbody>
            ${tops.slice(0, 8).map((p, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${App.ui.esc(p.name)}</td>
                <td class="right">${App.ui.qty(p.qty)}</td>
                <td class="right">${App.ui.money(p.total)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
      : '<div class="an-muted">No sales yet today.</div>';

    const refundRows = refunds || [];
    const refundPreview = refundRows.length
      ? `${refundRows.length} record${refundRows.length === 1 ? '' : 's'} · ${refundToday.tx} today · ${App.ui.money(refundToday.total)}`
      : (refundToday.tx ? `${refundToday.tx} today · ${App.ui.money(refundToday.total)}` : 'No refunds recorded');
    const refundBody = refundRows.length
      ? `<div style="overflow:auto;max-height:380px"><table class="an-table">
          <thead><tr>
            <th>Refund ID</th><th>Original Txn</th><th>Date</th><th>Cashier</th>
            <th>Approved By</th><th>Customer</th><th class="right">Amount</th><th>Reason</th>
          </tr></thead>
          <tbody>
            ${refundRows.map((r) => `<tr style="color:var(--danger)">
              <td class="mono">${App.ui.esc(r.refund_txn_id || '—')}</td>
              <td class="mono">${App.ui.esc(r.original_txn_id || '—')}</td>
              <td>${App.ui.fmtDate(r.datetime)}</td>
              <td>${App.ui.esc(r.cashier_name || '—')}</td>
              <td>${App.ui.esc(r.admin_name || '—')}</td>
              <td>${App.ui.esc(r.customer_name || 'Walk-in')}</td>
              <td class="right">${App.ui.money(r.total)}</td>
              <td class="muted">${App.ui.esc(r.reason || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`
      : '<div class="an-muted">No refunds recorded.</div>';

    const sections = [
      {
        key: 'topSellers',
        title: this.separate ? "Today's Top Sellers (Sales)" : "Today's Top Sellers",
        preview: topPreview,
        body: topBody,
      },
      { key: 'refunds', title: 'Refund History', preview: refundPreview, body: refundBody },
    ];

    sectionsEl.innerHTML = sections.map((sec) => {
      const open = !!this.openState[sec.key];
      const bodyId = `anSection-${sec.key}`;
      return `<section class="collapse-section${open ? ' open' : ''}" data-key="${sec.key}">
        <div class="collapse-h">
          <button type="button" class="collapse-toggle" aria-expanded="${open}" aria-controls="${bodyId}">
            <span class="collapse-arrow" aria-hidden="true">▸</span>
            <span class="collapse-info">
              <span class="collapse-title">${App.ui.esc(sec.title)}</span>
              <span class="collapse-preview muted">${sec.preview}</span>
            </span>
          </button>
        </div>
        <div class="collapse-b" id="${bodyId}"${open ? '' : ' hidden'}>${sec.body}</div>
      </section>`;
    }).join('');

    const updated = this.viewEl.querySelector('#anUpdated');
    if (updated) {
      updated.textContent = `Updated ${new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`;
    }
  },
};
