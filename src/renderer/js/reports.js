'use strict';
/* Admin: sales reports (today / month / year, best-selling, by cashier,
 * by day, best sales day) with CSV export and printable view. */
window.App = window.App || {};
App.views = App.views || {};

App.views.reports = {
  title: 'Reports',
  data: null,
  from: '', to: '',

  async render(view) {
    this.viewEl = view;
    view.innerHTML = `
      <div class="toolbar">
        <label class="fl" style="margin:0">From</label><input id="rFrom" type="date" style="max-width:150px">
        <label class="fl" style="margin:0">To</label><input id="rTo" type="date" style="max-width:150px">
        <button class="btn btn-primary btn-sm" id="rGo">Apply</button>
        <div class="fill"></div>
        <button class="btn btn-ghost btn-sm" id="rPrint">Print</button>
      </div>
      <div id="rStats" class="stat-grid"></div>
      <div class="row gap" style="align-items:flex-start;margin-top:14px;flex-wrap:wrap">
        <div class="panel fill" style="min-width:320px"><div class="panel-h">Best-selling Products <button class="btn btn-sm btn-ghost" data-x="bestSelling" style="float:right">CSV</button></div><div class="panel-b" id="rBest"></div></div>
        <div class="panel fill" style="min-width:280px"><div class="panel-h">Sales by Cashier <button class="btn btn-sm btn-ghost" data-x="byCashier" style="float:right">CSV</button></div><div class="panel-b" id="rCsr"></div></div>
      </div>
      <div class="panel" style="margin-top:14px"><div class="panel-h">Sales by Day <button class="btn btn-sm btn-ghost" data-x="salesByDay" style="float:right">CSV</button></div><div class="panel-b" id="rDay"></div></div>
      <div class="panel" style="margin-top:14px"><div class="panel-h">Recent Sales <button class="btn btn-sm btn-ghost" data-x="sales" style="float:right">CSV</button></div><div style="overflow:auto;max-height:360px"><table class="tbl" id="rList"></table></div></div>`;
    this._wire();
    await this._load();
  },

  _wire() {
    const v = this.viewEl;
    v.querySelector('#rGo').onclick = () => { this.from = v.querySelector('#rFrom').value; this.to = v.querySelector('#rTo').value; this._load(); };
    v.querySelector('#rPrint').onclick = () => this._print();
    v.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => this._csv(b.dataset.x));
    v.querySelector('#rList').addEventListener('click', (e) => {
      const txn = e.target.closest('[data-txn]')?.dataset.txn; if (!txn) return;
      App.printer.printReceiptFallback(txn).catch((err) => App.ui.toast(err.message, 'err'));
    });
  },

  async _load() {
    const f = { from: this.from || undefined, to: this.to || undefined };
    const [summary, best, csr, day, list] = await Promise.all([
      App.pos.reports.summary(),
      App.pos.reports.bestSelling(f),
      App.pos.reports.byCashier(f),
      App.pos.reports.salesByDay(f),
      App.pos.sales.list(f),
    ]);
    this.data = { summary, best, csr, day, list };
    this._render();
  },

  _render() {
    const d = this.data; const v = this.viewEl;
    const s = d.summary;
    v.querySelector('#rStats').innerHTML = `
      <div class="stat"><div class="k">Today</div><div class="v">${App.ui.money(s.today.total)}<small> / ${s.today.tx} transactions</small></div></div>
      <div class="stat"><div class="k">Yesterday</div><div class="v">${App.ui.money(s.yesterday.total)}<small> / ${s.yesterday.tx} transactions</small></div></div>
      <div class="stat"><div class="k">This Month</div><div class="v">${App.ui.money(s.month.total)}<small> / ${s.month.tx} transactions</small></div></div>
      <div class="stat"><div class="k">This Year</div><div class="v">${App.ui.money(s.year.total)}<small> / ${s.year.tx} transactions</small></div></div>
      <div class="stat"><div class="k">Best Sales Day</div><div class="v">${s.bestDay ? App.ui.money(s.bestDay.total) : '—'}<small>${s.bestDay ? '<br>' + App.ui.esc(s.bestDay.label) : ''}</small></div></div>`;
    v.querySelector('#rBest').innerHTML = d.best.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Total</th></tr></thead><tbody>
      ${d.best.map((b) => `<tr><td>${App.ui.esc(b.name)} <span class="muted mono">${App.ui.esc(b.sku)}</span></td><td class="right">${App.ui.qty(b.qty)}</td><td class="right">${App.ui.money(b.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No data.</div>';
    v.querySelector('#rCsr').innerHTML = d.csr.length ? `<table class="tbl"><thead><tr><th>Cashier</th><th class="right">Tx</th><th class="right">Total</th></tr></thead><tbody>
      ${d.csr.map((c) => `<tr><td>${App.ui.esc(c.cashier_name)}</td><td class="right">${c.tx}</td><td class="right">${App.ui.money(c.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No data.</div>';
    v.querySelector('#rDay').innerHTML = d.day.length ? `<table class="tbl"><thead><tr><th>Date</th><th class="right">Tx</th><th class="right">Total</th></tr></thead><tbody>
      ${d.day.map((x) => `<tr><td>${App.ui.esc(x.date)}</td><td class="right">${x.tx}</td><td class="right">${App.ui.money(x.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No data.</div>';
    v.querySelector('#rList').innerHTML = `<thead><tr><th>Txn</th><th>Date</th><th>Cashier</th><th>Customer</th><th class="right">Total</th><th>Pay</th><th></th></tr></thead><tbody>
      ${d.list.map((r) => `<tr><td class="mono" data-txn="${App.ui.esc(r.txn_id)}" style="cursor:pointer;text-decoration:underline">${App.ui.esc(r.txn_id)}</td><td>${App.ui.fmtDate(r.datetime)}</td><td>${App.ui.esc(r.cashier_name)}</td><td>${App.ui.esc(r.customer_name)}</td><td class="right">${App.ui.money(r.total)}</td><td>${App.ui.esc(r.payment_method)}</td><td><button class="btn btn-sm btn-ghost" data-txn="${App.ui.esc(r.txn_id)}">Reprint</button></td></tr>`).join('')}</tbody>`;
  },

  async _csv(type) {
    try { const p = await App.pos.reports.exportCSV(type, { from: this.from || undefined, to: this.to || undefined }); if (p) App.ui.toast('Exported: ' + p, 'ok'); }
    catch (e) { App.ui.toast(e.message, 'err'); }
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
