'use strict';
/* Shared UI helpers for YANKENT POS renderer. */
window.App = window.App || {};
App.pos = window.pos;          // bridge from preload (contextBridge)
App.currencySymbol = '₱';

App.ui = {
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  money(n) {
    const v = Number(n) || 0;
    const s = Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-' : '') + (App.currencySymbol || '₱') + s;
  },
  qty(q) {
    const n = Number(q);
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 1000) / 1000);
  },
  toast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show ' + type;
    clearTimeout(this._tt);
    this._tt = setTimeout(() => (t.className = ''), 2400);
  },
  el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  },
  modal({ title, bodyHtml, footerHtml = '', wide = false }) {
    const root = document.getElementById('modal-root');
    const wrap = App.ui.el(`<div class="modal-overlay"><div class="modal" style="${wide ? 'width:680px' : ''}">
      <div class="modal-h"><span>${App.ui.esc(title)}</span><span class="x">×</span></div>
      <div class="modal-b">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-f">${footerHtml}</div>` : ''}
    </div></div>`);
    root.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.x').onclick = close;
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    return { el: wrap, close, body: wrap.querySelector('.modal-b') };
  },
  confirm(message, opts = {}) {
    return new Promise((resolve) => {
      const m = App.ui.modal({
        title: opts.title || 'Please confirm',
        bodyHtml: `<p style="margin:0">${App.ui.esc(message)}</p>`,
        footerHtml: `<button class="btn btn-ghost" data-a="no">Cancel</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${opts.danger ? 'Delete' : 'OK'}</button>`,
      });
      m.el.querySelector('[data-a="yes"]').onclick = () => { m.close(); resolve(true); };
      m.el.querySelector('[data-a="no"]').onclick = () => { m.close(); resolve(false); };
    });
  },
  debounce(fn, ms = 250) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },
  fmtDate(d) {
    const dt = new Date(d);
    return dt.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  todayISO() { return new Date().toISOString().slice(0, 10); },
};
