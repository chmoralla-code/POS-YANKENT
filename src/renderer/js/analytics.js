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
  openState: { topSellers: false, refunds: false },

  async render(view) {
    this.viewEl = view;
    view.classList.add('view-analytics');
    view.innerHTML = `
      <div class="an-wrap">
        <div class="an-cards" id="anCards">
          <div class="an-card muted">Loading…</div>
        </div>
        <div class="collapse-list" id="anSections" style="margin-top:4px"></div>
      </div>`;
    // Click-anywhere-on-header toggles open/close for any section.
    view.querySelector('#anSections').addEventListener('click', (e) => {
      const hdr = e.target.closest('.collapse-h');
      if (!hdr) return;
      const sec = hdr.parentElement;
      const key = sec.dataset.key;
      sec.classList.toggle('open');
      this.openState[key] = sec.classList.contains('open');
    });
    await this._load();
  },

  async _load() {
    const cardsEl = this.viewEl.querySelector('#anCards');
    const sectionsEl = this.viewEl.querySelector('#anSections');
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

      cardsEl.innerHTML = `
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
        </div>
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

      sectionsEl.innerHTML = sections.map((sec) => `<div class="collapse-section${this.openState[sec.key] ? ' open' : ''}" data-key="${sec.key}">
        <div class="collapse-h" role="button" tabindex="0">
          <div class="collapse-arrow">▸</div>
          <div class="collapse-info">
            <div class="collapse-title">${App.ui.esc(sec.title)}</div>
            <div class="collapse-preview muted">${sec.preview}</div>
          </div>
        </div>
        <div class="collapse-b">${sec.body}</div>
      </div>`).join('');
    } catch (e) {
      cardsEl.innerHTML = '<div class="an-card muted">Analytics unavailable.</div>';
      sectionsEl.innerHTML = `<div class="an-muted">${App.ui.esc(e.message)}</div>`;
    }
  },
};
