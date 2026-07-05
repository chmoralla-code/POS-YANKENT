'use strict';
/* Shared UI helpers for YANKENT POS renderer. */
window.App = window.App || {};
App.pos = window.pos;          // bridge from preload (contextBridge)
App.currencySymbol = '₱';

// Category color coding (muted, professional palette)
App.categoryColors = {
  'Cement':     '#8d6e63',
  'Masonry':    '#e65100',
  'Lumber':     '#6d4c41',
  'Steel':      '#546e7a',
  'Plumbing':   '#1565c0',
  'Electrical': '#f9a825',
  'Paint':      '#2e7d32',
  'Tools':      '#c62828',
  'Fasteners':  '#6a1b9a',
  'Services':   '#00838f',
};
App.catColor = function (cat) { return (App.categoryColors && App.categoryColors[cat]) || '#757575'; };

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
  modal({ title, bodyHtml, footerHtml = '', wide = false, closeOnOverlay = true }) {
    const root = document.getElementById('modal-root');
    const wrap = App.ui.el(`<div class="modal-overlay"><div class="modal" style="${wide ? 'width:680px' : ''}">
      <div class="modal-h"><span>${App.ui.esc(title)}</span><span class="x">×</span></div>
      <div class="modal-b">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-f">${footerHtml}</div>` : ''}
    </div></div>`);
    root.appendChild(wrap);
    let onClose = null;
    const close = () => { if (onClose) onClose(); wrap.remove(); };
    wrap.querySelector('.x').onclick = close;
    // Only close on overlay (outside) click when explicitly allowed — form
    // modals like Edit Product / Adjust Stock opt out so an accidental
    // click outside doesn't discard unsaved edits.
    if (closeOnOverlay) wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    return { el: wrap, close, body: wrap.querySelector('.modal-b'), set onClose(fn) { onClose = fn; } };
  },
  confirm(message, opts = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; m.close(); resolve(v); } };
      const yesText = opts.okText || (opts.danger ? 'Delete' : 'OK');
      const noText = opts.cancelText || 'Cancel';
      const m = App.ui.modal({
        title: opts.title || 'Please confirm',
        bodyHtml: `<p style="margin:0">${App.ui.esc(message)}</p>`,
        footerHtml: `<button class="btn btn-ghost" data-a="no">${App.ui.esc(noText)}</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${App.ui.esc(yesText)}</button>`,
      });
      m.el.querySelector('[data-a="yes"]').onclick = () => done(true);
      m.el.querySelector('[data-a="no"]').onclick = () => done(false);
      // If the user dismisses via X or outside click, treat as Cancel.
      m.onClose = () => done(false);
    });
  },
  debounce(fn, ms = 250) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },
  fmtDate(d) {
    if (!d) return '—';
    const s = String(d);
    const dt = s.includes('T') || s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)
      ? new Date(s)
      : new Date(s.replace(' ', 'T'));
    return dt.toLocaleString('en-PH', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  todayISO() {
    const n = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  },
};
