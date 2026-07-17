'use strict';
/* Analytics dashboard — simple, readable cards visible to all roles.
 * Separated from POS so cashiers see a clean sales summary without
 * the catalog/cart clutter.
 *
 * Two collapsible sections below the stat cards:
 *   1. "Today's Top Sellers" — top products by revenue today.
 *   2. "Refund History"      — recent refunds with today/month totals.
 * Each section is closed by default and opens/closes on header click. */
window.App = window.App || {};
App.views = App.views || {};

App.views.analytics = {
  title: 'Analytics',
  viewEl: null,
  // Per-section open/close state so re-renders (e.g. after data refresh)
  // preserve what the cashier already expanded.
  openState: { topSellers: true, refunds: false },

  async render(view) {
    this.viewEl = view;
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
            <button type="button" class="btn btn-sm btn-ghost" id="anRefresh">Refresh</button>
          </div>
        </header>
        <div class="an-dashboard-groups" id="anCards" aria-busy="true">
          <section class="an-group" aria-labelledby="anSalesHeading">
            <div class="an-group-heading"><h3 id="anSalesHeading">Sales overview</h3><p>Rolling store totals and the best recorded day.</p></div>
            <div class="an-cards" id="anSalesCards"><div class="an-card muted">Loading…</div></div>
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
    view.querySelector('#anSections').addEventListener('click', (e) => {
      const toggle = e.target.closest('.collapse-toggle');
      if (!toggle) return;
      const sec = toggle.closest('.collapse-section');
      const key = sec.dataset.key;
      const open = !sec.classList.contains('open');
      this._setSectionOpen(sec, open);
      this.openState[key] = open;
    });
    await this._load();
  },

  _setSectionOpen(section, open) {
    section.classList.toggle('open', open);
    const toggle = section.querySelector('.collapse-toggle');
    const body = section.querySelector('.collapse-b');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (body) body.hidden = !open;
  },

  async _load() {
    const cardsEl = this.viewEl.querySelector('#anCards');
    const salesCardsEl = this.viewEl.querySelector('#anSalesCards');
    const opsCardsEl = this.viewEl.querySelector('#anOpsCards');
    const sectionsEl = this.viewEl.querySelector('#anSections');
    cardsEl.setAttribute('aria-busy', 'true');
    try {
      const [summary, analytics, refunds, refundSummary] = await Promise.all([
        App.pos.reports.summary(),
        App.pos.reports.analytics(),
        App.pos.refunds.list({ limit: 100 }),
        App.pos.refunds.summary(),
      ]);
      const a = analytics || {};
      const s = summary || {};
      const today = s.today || { tx: 0, total: 0 };
      const yesterday = s.yesterday || { tx: 0, total: 0 };
      const month = s.month || { tx: 0, total: 0 };
      const year = s.year || { tx: 0, total: 0 };
      const best = s.bestDay;
      const avg = today.tx > 0 ? a.avgTx : 0;
      const items = Math.round(a.itemsSold || 0);
      const pays = (a.payBreak || []).map((p) => `${App.ui.esc(p.payment_method)}: ${App.ui.money(p.total)}`).join(' · ') || '—';

      const rs = refundSummary || {};
      const refundToday = rs.today || { tx: 0, total: 0 };
      const refundMonth = rs.month || { tx: 0, total: 0 };

      salesCardsEl.innerHTML = `
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
          <div class="an-k">This Month</div>
          <div class="an-v">${App.ui.money(month.total)}</div>
          <div class="an-sub">${month.tx} transactions</div>
        </div>
        <div class="an-card">
          <div class="an-k">This Year</div>
          <div class="an-v">${App.ui.money(year.total)}</div>
          <div class="an-sub">${year.tx} transactions</div>
        </div>
        <div class="an-card">
          <div class="an-k">Best Day</div>
          <div class="an-v">${best ? App.ui.money(best.total) : '—'}</div>
          <div class="an-sub">${best ? App.ui.esc(best.label) : ''}</div>
        </div>`;
      opsCardsEl.innerHTML = `
        <div class="an-card">
          <div class="an-k">Avg. Transaction</div>
          <div class="an-v">${App.ui.money(avg)}</div>
          <div class="an-sub">per sale today</div>
        </div>
        <div class="an-card">
          <div class="an-k">Items Sold Today</div>
          <div class="an-v">${items}</div>
          <div class="an-sub">units</div>
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

      // ---- Today's Top Sellers (collapsible) --------------------------
      const tops = a.topProducts || [];
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

      // ---- Refund History (collapsible) -------------------------------
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
        { key: 'topSellers', title: "Today's Top Sellers", preview: topPreview, body: topBody },
        { key: 'refunds',    title: 'Refund History',      preview: refundPreview, body: refundBody },
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
      if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`;
    } catch (e) {
      salesCardsEl.innerHTML = '<div class="an-card muted">Analytics unavailable.</div>';
      opsCardsEl.innerHTML = '';
      sectionsEl.innerHTML = `<div class="an-muted">${App.ui.esc(e.message)}</div>`;
      const updated = this.viewEl.querySelector('#anUpdated');
      if (updated) updated.textContent = 'Unable to refresh';
    } finally {
      cardsEl.setAttribute('aria-busy', 'false');
    }
  },
};
