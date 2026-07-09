'use strict';
/* POS sales screen — catalog + cart + checkout + receipt. */
window.App = window.App || {};
App.views = App.views || {};
App.cart = App.cart || [];

App.views.pos = {
  title: 'Point of Sale',
  cache: { products: [], categories: [], customers: [] },
  state: { tab: 'products', cat: 'all', q: '', customer: null, pay: 'cash', discountOn: false, chipsOpen: false },

  async render(view) {
    this.viewEl = view;
    view.classList.add('view-pos');
    // Always fetch fresh data so admin changes (price, stock, categories) sync immediately.
    const [products, categories, customers] = await Promise.all([
      App.pos.products.list({ includeServices: true }),
      App.pos.categories.list(),
      App.pos.customers.list(),
    ]);
    this.cache = { products, categories, customers };
    view.innerHTML = `
      <div class="pos-grid">
        <div class="pos-left">
          <div class="panel pos-catalog">
            <div class="search-row">
              <input id="posSearch" placeholder="Search SKU / item name…" autocomplete="off">
            </div>
            <div class="tabs" id="posTabs">
              <div class="tab active" data-tab="products">Products <span class="tab-count" id="posCountProducts">0</span></div>
              <div class="tab" data-tab="services">Services <span class="tab-count" id="posCountServices">0</span></div>
            </div>
            <div class="chips-wrap" id="posChipsWrap" hidden>
              <button class="chips-toggle" id="posChipsToggle" type="button" aria-expanded="false">
                <span class="chips-toggle-arrow">▸</span><span>Categories</span>
              </button>
              <div class="chips" id="posChips" hidden></div>
            </div>
            <div class="prod-grid" id="posGrid"></div>
          </div>
        </div>
        <div class="pos-right">
          <div class="panel">
            <div class="panel-h">Current Sale <small><span id="posCount">0</span> lines</small></div>
            <div class="cart" id="posCart"></div>
            <div class="totals" id="posTotals"></div>
            <div class="pay-grid" id="posPay">
              <button class="active" data-pay="cash">Cash</button>
              <button data-pay="card">Card</button>
              <button data-pay="ewallet">E-Wallet</button>
              <button data-pay="account">On-Account</button>
            </div>
            <div class="ck">
              <button class="btn btn-ghost" id="posVoid">Void</button>
              <button class="btn btn-ghost" id="posDiscount" title="Apply admin-set discount %">Discount</button>
              <button class="btn btn-ghost" id="posRefund" title="Process a refund for a completed sale">Refund</button>
              <button class="btn btn-primary" id="posCharge">Charge ₱0.00</button>
            </div>
          </div>
        </div>
      </div>`;

    this._wire();
    this._renderChips();
    this._renderGrid();
    this._renderCart();
  },

  _wire() {
    const v = this.viewEl;
    const debounced = App.ui.debounce(() => this._renderGrid(), 200);
    v.querySelector('#posSearch').addEventListener('input', (e) => { this.state.q = e.target.value; debounced(); });
    v.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
      v.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); this.state.tab = t.dataset.tab; this._renderChips(); this._renderGrid();
    });
    const toggle = v.querySelector('#posChipsToggle');
    if (toggle) toggle.onclick = () => { this.state.chipsOpen = !this.state.chipsOpen; this._renderChips(); };
    v.querySelectorAll('#posPay button').forEach((b) => b.onclick = () => this._setPay(b.dataset.pay));
    v.querySelector('#posVoid').onclick = () => this._void();
    v.querySelector('#posDiscount').onclick = () => {
      const pct = parseFloat((App.settingsCache || {}).discount_percent) || 0;
      if (pct <= 0) { App.ui.toast('No discount set (admin controls this)', 'err'); return; }
      this.state.discountOn = !this.state.discountOn;
      const btn = v.querySelector('#posDiscount');
      btn.classList.toggle('btn-primary', this.state.discountOn);
      btn.classList.toggle('btn-ghost', !this.state.discountOn);
      btn.textContent = this.state.discountOn ? `Discount ${pct}% ✓` : 'Discount';
      this._renderCart();
    };
    v.querySelector('#posCharge').onclick = () => this._checkout();
    v.querySelector('#posRefund').onclick = () => this._startRefund();
    v.querySelector('#posCart').addEventListener('click', (e) => this._cartClick(e));
    v.querySelector('#posCart').addEventListener('change', (e) => this._cartChange(e));
    // keyboard: Enter in search adds first match
    v.querySelector('#posSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const first = v.querySelector('#posGrid .prod-card'); if (first) first.click(); }
    });
  },

  async _renderAnalytics() {
    const el = this.viewEl.querySelector('#posAnalytics');
    if (!el) return;
  },

  _renderChips() {
    const wrap = this.viewEl.querySelector('#posChipsWrap');
    const toggle = this.viewEl.querySelector('#posChipsToggle');
    const el = this.viewEl.querySelector('#posChips');
    if (!wrap || !el) return;
    // Services tab: hide the whole categories panel.
    if (this.state.tab === 'services') { wrap.hidden = true; el.innerHTML = ''; return; }
    wrap.hidden = false;
    // Reflect open/closed state on toggle + chips container.
    const open = !!this.state.chipsOpen;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.chips-toggle-arrow').textContent = open ? '▾' : '▸';
    el.hidden = !open;
    if (!open) return;
    const cats = this.cache.categories;
    const all = `<div class="chip ${this.state.cat === 'all' ? 'active' : ''}" data-cat="all">All</div>`;
    el.innerHTML = all + cats.map((c) => {
      const col = App.catColor(c.name);
      const isActive = this.state.cat === c.name;
      return `<div class="chip ${isActive ? 'active' : ''}" data-cat="${App.ui.esc(c.name)}" style="${isActive ? `background:${col};border-color:${col}` : `border-left:3px solid ${col}`}">${App.ui.esc(c.name)}</div>`;
    }).join('');
    el.querySelectorAll('.chip').forEach((ch) => ch.onclick = () => { this.state.cat = ch.dataset.cat; this._renderChips(); this._renderGrid(); });
  },

  _renderGrid() {
    const el = this.viewEl.querySelector('#posGrid');
    // Update tab counts (total products / total services in cache).
    const all = this.cache.products || [];
    const prodCount = all.filter((p) => !p.is_service).length;
    const svcCount = all.filter((p) => p.is_service).length;
    const pc = this.viewEl.querySelector('#posCountProducts');
    const sc = this.viewEl.querySelector('#posCountServices');
    if (pc) pc.textContent = prodCount;
    if (sc) sc.textContent = svcCount;
    const q = this.state.q.toLowerCase().trim();
    let list = this.cache.products;
    if (this.state.tab === 'products') list = list.filter((p) => !p.is_service);
    else list = list.filter((p) => p.is_service);
    if (this.state.tab === 'products' && this.state.cat !== 'all') list = list.filter((p) => p.category === this.state.cat);
    if (q) list = list.filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (!list.length) { el.innerHTML = '<div class="empty-state">No items found.</div>'; return; }
    if (this.state.tab === 'products') {
      el.innerHTML = list.map((p) => {
        const def = (p.units && p.units[0]) || { unit: p.base_unit, price: p.price };
        const low = p.stock <= (p.low || 10);
        const out = p.stock <= 0;
        const col = App.catColor(p.category);
        const cls = out ? 'out-of-stock' : 'in-stock';
        return `<div class="prod-card ${cls}" data-id="${p.id}" style="border-left:4px solid ${col}" title="${App.ui.esc(p.name)}">
          <div class="nm">${App.ui.esc(p.name)}</div>
          <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
          <div class="stk ${out ? 'low' : low ? 'low' : ''}">${out ? 'OUT OF STOCK' : 'Stock: ' + App.ui.qty(p.stock) + ' ' + App.ui.esc(p.base_unit)}${(!out && p.units && p.units.length > 1) ? ' · ' + p.units.length + ' units' : ''}</div>
        </div>`;
      }).join('');
    } else {
      el.innerHTML = list.map((p) => {
        const def = (p.units && p.units[0]) || { unit: p.base_unit, price: p.price };
        return `<div class="prod-card svc-card" data-id="${p.id}" title="${App.ui.esc(p.name)}">
          <div class="nm">${App.ui.esc(p.name)}</div>
          <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
          <div class="stk">Service</div>
        </div>`;
      }).join('');
    }
    el.querySelectorAll('.prod-card').forEach((c) => c.onclick = () => this._add(+c.dataset.id));
  },

  _add(id) {
    const p = this.cache.products.find((x) => x.id === id);
    if (!p) return;
    if (p.is_service) {
      // Use a styled modal instead of the blocking native prompt() — the
      // native prompt is theme-inconsistent and can be disabled by sandbox
      // configs, which would silently break adding services to the cart.
      const m = App.ui.modal({
        title: 'Quantity — ' + p.name, closeOnOverlay: false,
        bodyHtml: `<div class="field"><label class="fl">Quantity (${(p.units[0] || {}).unit || p.base_unit})</label><input id="svcQty" type="number" step="0.01" value="1" autofocus></div>`,
        footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Add to cart</button>`,
      });
      m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
      const input = m.el.querySelector('#svcQty');
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('[data-a="ok"]').click(); });
      m.el.querySelector('[data-a="ok"]').onclick = () => {
        const n = parseFloat(input.value);
        if (!n || n <= 0) { App.ui.toast('Invalid quantity', 'err'); return; }
        const u = p.units[0] || { unit: p.base_unit, factor: 1, price: p.price };
        App.cart.push({ productId: p.id, sku: p.sku, name: p.name, unit: u.unit, factor: u.factor, unitPrice: u.price, qty: n, isService: true, lineType: 'service', units: p.units, base_unit: p.base_unit });
        m.close();
        this._renderCart();
      };
    } else {
      if (p.stock <= 0) { App.ui.toast(p.name + ' is out of stock', 'err'); return; }
      const ex = App.cart.find((i) => i.productId === id && !i.isService);
      const u = (p.units && p.units[0]) || { unit: p.base_unit, factor: 1, price: p.price };
      if (ex) {
        const newConsumed = (ex.qty + 1) * ex.factor;
        if (newConsumed > p.stock + 1e-9) { App.ui.toast('Not enough stock for ' + p.name, 'err'); return; }
        ex.qty++;
      } else {
        App.cart.push({ productId: p.id, sku: p.sku, name: p.name, unit: u.unit, factor: u.factor, unitPrice: u.price, qty: 1, isService: false, lineType: 'product', units: p.units, base_unit: p.base_unit, stock: p.stock });
      }
    }
    this._renderCart();
  },

  _cartClick(e) {
    const row = e.target.closest('[data-idx]');
    if (!row) return;
    const i = +row.dataset.idx;
    if (e.target.dataset.act === 'rm') { App.cart.splice(i, 1); this._renderCart(); }
    else if (e.target.dataset.act === 'minus') { this._adjQty(i, -1); }
    else if (e.target.dataset.act === 'plus') { this._adjQty(i, 1); }
  },
  _cartChange(e) {
    const row = e.target.closest('[data-idx]');
    if (!row) return;
    const i = +row.dataset.idx;
    if (e.target.dataset.field === 'qty') { this._setQty(i, e.target.value); }
    else if (e.target.dataset.field === 'unit') { this._setUnit(i, e.target.value); }
  },
  _adjQty(i, d) {
    const it = App.cart[i]; if (!it) return;
    if (d > 0 && !it.isService) {
      const p = this.cache.products.find((x) => x.id === it.productId);
      if (p) { const newConsumed = (it.qty + d) * it.factor; if (newConsumed > p.stock + 1e-9) { App.ui.toast('Not enough stock for ' + it.name, 'err'); return; } }
    }
    it.qty = +it.qty + d; if (it.qty <= 0) App.cart.splice(i, 1); this._renderCart();
  },
  _setQty(i, v) {
    const it = App.cart[i]; if (!it) return;
    const n = parseFloat(v);
    if (!n || n <= 0) { App.cart.splice(i, 1); this._renderCart(); return; }
    if (!it.isService) {
      const p = this.cache.products.find((x) => x.id === it.productId);
      if (p) { const newConsumed = n * it.factor; if (newConsumed > p.stock + 1e-9) { App.ui.toast('Not enough stock for ' + it.name, 'err'); this._renderCart(); return; } }
    }
    it.qty = n; this._renderCart();
  },
  _setUnit(i, unit) {
    const it = App.cart[i]; if (!it) return;
    const u = (it.units || []).find((x) => x.unit === unit) || { unit, factor: 1, price: it.unitPrice };
    it.unit = u.unit; it.factor = u.factor; it.unitPrice = u.price; this._renderCart();
  },

  _renderCart() {
    const el = this.viewEl.querySelector('#posCart');
    if (!App.cart.length) { el.innerHTML = '<div class="cart-empty">Cart is empty. Click an item to start.</div>'; }
    else {
      el.innerHTML = App.cart.map((i, idx) => {
        const amt = i.qty * i.unitPrice;
        const unitSel = (i.units && i.units.length > 1)
          ? `<select data-field="unit">${i.units.map((u) => `<option ${u.unit === i.unit ? 'selected' : ''}>${App.ui.esc(u.unit)}</option>`).join('')}</select>`
          : `<span class="muted">${App.ui.esc(i.unit)}</span>`;
        return `<div class="cart-row ${i.isService ? 'svc' : ''}" data-idx="${idx}">
          <div>
            <div class="nm">${App.ui.esc(i.name)}${i.isService ? ' <span class="badge svc">svc</span>' : ''}</div>
            <div class="meta">${App.ui.money(i.unitPrice)} / ${App.ui.esc(i.unit)}</div>
          </div>
          <div class="qty">
            <button data-act="minus">−</button>
            <input data-field="qty" type="number" step="0.001" value="${App.ui.qty(i.qty)}">
            <button data-act="plus">+</button>
          </div>
          <div class="amt">${App.ui.money(amt)} <span class="rm" data-act="rm">✕</span>
            <div class="cart-unit">${unitSel}</div>
          </div>
        </div>`;
      }).join('');
    }
    this._compute();
  },

  _compute() {
    const mat = App.cart.filter((i) => !i.isService).reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const svc = App.cart.filter((i) => i.isService).reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const gross = mat + svc;
    const vatRate = parseFloat((App.settingsCache || {}).vat_rate) || 12;
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    const discAmt = gross * discPct / 100;
    // VAT-exclusive: subtotal is the net (items − discount), VAT is added on
    // top, total = subtotal + VAT.  Item prices do NOT include VAT.
    const subtotal = Math.max(0, gross - discAmt);
    const vat = subtotal * vatRate / 100;
    const total = subtotal + vat;
    let discLine = '';
    if (discPct > 0) {
      discLine = `<div class="r"><span class="l">Discount (${discPct}% off)</span><span>−${App.ui.money(discAmt)}</span></div>`;
    }
    this.viewEl.querySelector('#posTotals').innerHTML = `
      <div class="r"><span class="l">Materials</span><span>${App.ui.money(mat)}</span></div>
      <div class="r"><span class="l">Services</span><span>${App.ui.money(svc)}</span></div>
      <div class="r"><span class="l">Subtotal (net)</span><span>${App.ui.money(subtotal)}</span></div>
      ${discLine}
      <div class="r"><span class="l">VAT ${vatRate}%</span><span>+${App.ui.money(vat)}</span></div>
      <div class="r g"><span>TOTAL</span><span>${App.ui.money(total)}</span></div>`;
    this.viewEl.querySelector('#posCount').textContent = App.cart.length;
    this.viewEl.querySelector('#posCharge').textContent = 'Charge ' + App.ui.money(total);
  },

  _setPay(p) {
    if (p === 'account' && !(this.state.customer && this.state.customer.type === 'contractor')) {
      App.ui.toast('On-Account requires a contractor customer', 'err'); return;
    }
    this.state.pay = p;
    this.viewEl.querySelectorAll('#posPay button').forEach((b) => b.classList.toggle('active', b.dataset.pay === p));
  },

  _void() {
    if (!App.cart.length) return;
    App.ui.confirm('Void the entire current sale?').then((ok) => { if (ok) { App.cart = []; this._renderCart(); App.ui.toast('Sale voided'); } });
  },

  _checkout() {
    if (!App.cart.length) { App.ui.toast('Cart is empty', 'err'); return; }
    const gross = App.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const vatRate = parseFloat((App.settingsCache || {}).vat_rate) || 12;
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    // VAT-exclusive: subtotal = net (items − discount), total = subtotal + VAT
    const subtotal = Math.max(0, gross - gross * discPct / 100);
    const total = subtotal + subtotal * vatRate / 100;
    const pay = this.state.pay;
    const cust = this.state.customer;
    let cashHtml = '', refHtml = '';
    if (pay === 'cash') cashHtml = `<div class="field"><label class="fl">Cash Received</label><input id="payCash" type="number" step="0.01" value="${total.toFixed(2)}" autofocus></div><div id="changeBox" class="credit-info"></div>`;
    if (pay === 'card' || pay === 'ewallet') refHtml = `<div class="field"><label class="fl">Reference No.</label><input id="payRef" placeholder="Transaction ref (optional)"></div>`;
    const custName = cust ? cust.name : 'Walk-in Customer';
    const m = App.ui.modal({
      title: 'Complete Payment', wide: false, closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Amount Due (incl. VAT ${vatRate}%)</label><input value="${App.ui.money(total)}" readonly></div>
        <div class="row gap" style="margin-bottom:10px"><span class="badge ${pay}">${pay.toUpperCase()}</span><span class="muted">${App.ui.esc(custName)}</span></div>
        ${cashHtml}${refHtml}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Confirm &amp; Print</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Processing…'; btn.classList.add('is-printing');
      m.close();
      this._confirm(total, pay, cust);
    };
    if (pay === 'cash') {
      const cash = m.el.querySelector('#payCash');
      const upd = () => {
        const c = parseFloat(cash.value) || 0; const ch = c - total;
        const box = m.el.querySelector('#changeBox');
        box.innerHTML = ch >= 0 ? `Change: <b>${App.ui.money(ch)}</b>` : `<span style="color:var(--danger)">Short: ${App.ui.money(-ch)}</span>`;
      };
      cash.addEventListener('input', upd); upd();
    }
  },

  async _confirm(total, pay, cust) {
    const gross = App.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    const discAmt = gross * discPct / 100;
    const payload = {
      items: App.cart.map((i) => ({
        productId: i.productId, sku: i.sku, name: i.name, unit: i.unit,
        qty: i.qty, unitPrice: i.unitPrice, factor: i.factor,
        isService: i.isService, lineType: i.lineType,
      })),
      customerId: cust ? cust.id : null,
      customerName: cust ? cust.name : 'Walk-in Customer',
      paymentMethod: pay,
      amountTendered: pay === 'cash' ? total : 0,
      discount: discAmt,
      reference: '',
    };
    try {
      // Create a PENDING sale — stock is NOT deducted yet.  The sale is
      // only committed (stock deducted) when the cashier clicks PRINT on
      // the receipt modal.  Closing the modal without printing voids it.
      const res = await App.pos.sales.create(payload);
      App.ui.toast(`Sale ${res.txnId} — click PRINT to complete`, 'ok');
      await this._showReceipt(res.txnId, res.receipt);
    } catch (e) {
      App.ui.toast(e.message, 'err');
    }
  },

  _resetCartState() {
    App.cart = [];
    this.state.customer = null;
    this.state.discountOn = false;
    const dBtn = this.viewEl.querySelector('#posDiscount');
    if (dBtn) { dBtn.classList.remove('btn-primary'); dBtn.classList.add('btn-ghost'); dBtn.textContent = 'Discount'; }
    this._setPay('cash');
    this._renderChips(); this._renderGrid(); this._renderCart();
  },

  /** Print a receipt, auto-reconnecting once if the printer dropped.
   *  Handles the common power-cycle case: after a laptop is turned off and
   *  on again, the cached GATT characteristic is dead.  printReceipt already
   *  retries Bluetooth and falls back to the named Windows printer (POS-58)
   *  via the winspool RAW path — the same path the startup auto test-print
   *  uses.  This wrapper adds one extra retry on a mid-write GATT failure. */
  async _printWithRetry(txnId) {
    try {
      await App.printer.printReceipt(txnId);
      return;
    } catch (e) {
      // If the Bluetooth write threw after the characteristic died mid-print,
      // one more reconnect-with-retry + retry can recover it.
      if (/not connected|disconnect|network|gatt/i.test(e.message || '')) {
        const reconnected = await App.printer.reconnectWithRetry();
        if (reconnected) { await App.printer.printReceipt(txnId); return; }
      }
      // Final fallback: send directly to the named Windows printer (POS-58)
      // via winspool RAW — works for USB thermal printers regardless of
      // printer_type setting.
      try {
        await App.pos.printer.printReceiptRaw(txnId);
        return;
      } catch (e2) {
        throw e2;
      }
    }
  },

  async _showReceipt(txnId, receipt) {
    const text = receipt ? null : (await App.pos.printer.encodeReceipt(txnId)).text;
    const body = (receipt && receipt.items) ? this._receiptHtml(receipt) : `<pre class="receipt">${App.ui.esc(text)}</pre>`;
    const m = App.ui.modal({
      title: 'Receipt · ' + txnId, wide: true, closeOnOverlay: false,
      bodyHtml: body,
      footerHtml: `<button class="btn btn-primary" data-a="print">PRINT</button>`,
    });
    // Track whether the sale was committed via PRINT so the close handler
    // knows whether to void it.
    let committed = false;

    // PRINT: commit the sale (deduct stock + mark completed), print the
    // receipt, then close the modal and clear the cart for the next sale.
    m.el.querySelector('[data-a="print"]').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Printing…'; btn.classList.add('is-printing');
      try {
        // 1. Commit the pending sale → deducts stock, writes movements,
        //    updates contractor credit, sets status='completed'.
        await App.pos.sales.commit(txnId);
        // Mark committed IMMEDIATELY so that if printing fails, closing
        // the modal won't try to void an already-completed sale (which
        // would throw a swallowed error and show a false "voided" toast,
        // tempting the cashier to re-charge → double deduction).
        committed = true;
        // 2. Print the receipt — Bluetooth if connected, else system printer.
        //    _printWithRetry auto-reconnects once if the printer dropped
        //    (e.g. USB cable was unplugged and re-plugged).
        await this._printWithRetry(txnId);
        App.ui.toast('Sale completed ✓', 'ok');
        // 3. Refresh cached product stock (now that stock is deducted).
        this.cache.products = await App.pos.products.list({ includeServices: true });
        this.cache.customers = await App.pos.customers.list();
        // 4. Close modal + reset cart for the next sale.
        m.close();
        this._resetCartState();
      } catch (err) {
        // If commit succeeded but print failed, the sale is already
        // completed — offer a reprint rather than leaving the cashier
        // stuck on a disabled PRINT button.
        if (committed) {
          App.ui.toast('Sale completed but printing failed — click PRINT again to reprint', 'err');
          btn.textContent = 'REPRINT'; btn.classList.remove('is-printing');
          // On a successful reprint, close + reset cart.
          btn.onclick = async (ev2) => {
            btn.disabled = true; btn.textContent = 'Printing…'; btn.classList.add('is-printing');
            try {
              await this._printWithRetry(txnId);
              App.ui.toast('Reprinted ✓', 'ok');
              m.close(); this._resetCartState();
            } catch (e2) {
              App.ui.toast('Reprint failed: ' + e2.message, 'err');
              btn.disabled = false; btn.textContent = 'REPRINT'; btn.classList.remove('is-printing');
            }
          };
        } else {
          App.ui.toast(err.message, 'err');
        }
        btn.disabled = false;
        if (!committed) { btn.textContent = 'PRINT'; btn.classList.remove('is-printing'); }
      }
    };

    // Close (× or overlay) without PRINT → void the pending sale so it
    // doesn't linger in the database.  The cart stays populated so the
    // cashier can adjust and retry, but the discount/customer/pay-method
    // state are reset so a retry doesn't silently reuse stale selections.
    m.onClose = async () => {
      if (committed) return; // sale was committed via PRINT — nothing to void
      try {
        await App.pos.sales.void(txnId);
        // Reset sale-specific state (keep cart items for retry).
        this.state.discountOn = false;
        this.state.customer = null;
        this._setPay('cash');
        const dBtn = this.viewEl.querySelector('#posDiscount');
        if (dBtn) { dBtn.classList.remove('btn-primary'); dBtn.classList.add('btn-ghost'); dBtn.textContent = 'Discount'; }
        this._renderCart();
        App.ui.toast('Sale voided (not printed) — cart kept so you can retry', 'err');
      } catch (e) {
        // Sale may already be voided/committed — ignore.
      }
    };
  },

  _receiptHtml(r) {
    const sym = App.currencySymbol;
    const lines = r.items.map((i) => `<div class="r"><span>${App.ui.qty(i.qty)} ${App.ui.esc(i.unit)} ${App.ui.esc(i.name)}</span><span>${App.ui.money(i.amount)}</span></div>`).join('');
    return `<div class="receipt"><div class="store">${App.ui.esc(r.storeName)}</div>
      <div style="text-align:center">${App.ui.esc(r.address || '')}<br>${r.tin ? 'TIN: ' + App.ui.esc(r.tin) : ''}</div>
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      <div class="r"><span>Txn</span><span>${App.ui.esc(r.txnId)}</span></div>
      <div class="r"><span>Date</span><span>${App.ui.esc(r.datetime)}</span></div>
      <div class="r"><span>Cashier</span><span>${App.ui.esc(r.cashier)}</span></div>
      <div class="r"><span>Customer</span><span>${App.ui.esc(r.customer)}</span></div>
      <div class="r"><span>Pay</span><span>${App.ui.esc(r.paymentMethod.toUpperCase())}</span></div>
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      ${lines}
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      <div class="r"><span>Subtotal (net)</span><span>${App.ui.money(r.subtotal)}</span></div>
      ${r.discount > 0 ? `<div class="r"><span>Discount</span><span>−${App.ui.money(r.discount)}</span></div>` : ''}
      ${r.deliveryFee > 0 ? `<div class="r"><span>Delivery</span><span>${App.ui.money(r.deliveryFee)}</span></div>` : ''}
      ${r.vat > 0 || (r.vatRate ?? 12) > 0 ? `<div class="r"><span>VAT ${r.vatRate ?? 12}%</span><span>+${App.ui.money(r.vat)}</span></div>` : ''}
      <div class="r" style="font-weight:800;font-size:14px;margin-top:4px"><span>TOTAL</span><span>${App.ui.money(r.total)}</span></div>
      ${r.paymentMethod === 'cash' ? `<div class="r"><span>Cash</span><span>${App.ui.money(r.tendered)}</span></div><div class="r"><span>Change</span><span>${App.ui.money(r.change)}</span></div>` : ''}
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      <div style="text-align:center">${App.ui.esc(r.footer || '').replace(/\n/g, '<br>')}</div></div>`;
  },

  // ---- Refund flow --------------------------------------------------------
  // Step 1: enter transaction ID from the receipt
  _startRefund() {
    const m = App.ui.modal({
      title: 'Process Refund', closeOnOverlay: false,
      bodyHtml: `<div class="hint" style="margin-bottom:10px">Enter the transaction ID from the customer's receipt (e.g. YK-000042).</div>
        <div class="field"><label class="fl">Transaction ID</label><input id="rfTxn" placeholder="YK-000042" autofocus></div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="lookup">Look Up</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="lookup"]').onclick = async () => {
      const txn = m.el.querySelector('#rfTxn').value.trim().toUpperCase();
      if (!txn) { App.ui.toast('Enter a transaction ID', 'err'); return; }
      try {
        const sale = await App.pos.refunds.lookup(txn);
        if (!sale) { App.ui.toast('Sale not found or already refunded', 'err'); return; }
        m.close();
        this._showRefundSale(sale);
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  // Step 2: show the sale details + process refund (no admin approval needed)
  _showRefundSale(sale) {
    const itemsHtml = sale.items.map((i) => `<tr><td>${App.ui.esc(i.name)}</td><td class="right">${App.ui.qty(i.qty)} ${App.ui.esc(i.unit)}</td><td class="right">${App.ui.money(i.amount)}</td></tr>`).join('');
    const m = App.ui.modal({
      title: 'Refund — ' + sale.txn_id, wide: true, closeOnOverlay: false,
      bodyHtml: `<div class="hint" style="margin-bottom:8px">
          <b>Date:</b> ${App.ui.esc(sale.datetime)} · <b>Cashier:</b> ${App.ui.esc(sale.cashier_name)} · <b>Pay:</b> ${App.ui.esc(sale.payment_method.toUpperCase())} · <b>Customer:</b> ${App.ui.esc(sale.customer_name)}
        </div>
        <table class="tbl"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead><tbody>${itemsHtml}</tbody></table>
        <div class="totals" style="border:none;padding:8px 0"><div class="r g"><span>TOTAL REFUND</span><span>${App.ui.money(sale.total)}</span></div></div>
        <div class="field"><label class="fl">Reason (optional)</label><input id="rfReason" placeholder="Customer return / wrong item / damaged"></div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-danger" data-a="refund">Process Refund</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="refund"]').onclick = async () => {
      const btn = m.el.querySelector('[data-a="refund"]'); btn.disabled = true; btn.textContent = 'Processing…';
      try {
        const reason = m.el.querySelector('#rfReason').value.trim();
        const result = await App.pos.refunds.process({ txnId: sale.txn_id, adminName: (App.current.user && App.current.user.full_name) || sale.cashier_name || '—', adminId: App.current.user ? App.current.user.id : null, reason });
        m.close();
        // Show refund receipt
        this._showRefundReceipt(sale, result, reason, (App.current.user && App.current.user.full_name) || sale.cashier_name || '—');
        // Refresh stock
        this.cache.products = await App.pos.products.list({ includeServices: true });
        this._renderGrid();
      } catch (e) { App.ui.toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Process Refund'; }
    };
  },

  // Step 3: show the refund receipt confirmation
  _showRefundReceipt(sale, result, reason, adminName) {
    // Capture the cashier name up front — the idle timeout may fire
    // between the refund completing and this modal rendering, which
    // nulls App.current.user and would throw on .full_name access.
    const cashierName = (App.current && App.current.user && App.current.user.full_name) || sale.cashier_name || '—';
    const m = App.ui.modal({
      title: 'Refund Processed ✓', wide: true,
      bodyHtml: `<div class="receipt"><div class="store">YANKENT POS</div>
        <div style="text-align:center;color:#666;font-size:10px">REFUND RECEIPT</div>
        <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
        <div class="r"><span>Refund ID</span><span>${App.ui.esc(result.refundTxnId)}</span></div>
        <div class="r"><span>Original Txn</span><span>${App.ui.esc(sale.txn_id)}</span></div>
        <div class="r"><span>Date</span><span>${new Date().toLocaleString()}</span></div>
        <div class="r"><span>Cashier</span><span>${App.ui.esc(cashierName)}</span></div>
        <div class="r"><span>Approved by</span><span>${App.ui.esc(adminName)}</span></div>
        <div class="r"><span>Customer</span><span>${App.ui.esc(sale.customer_name)}</span></div>
        <div class="r"><span>Pay</span><span>${App.ui.esc(sale.payment_method.toUpperCase())}</span></div>
        ${reason ? `<div class="r"><span>Reason</span><span>${App.ui.esc(reason)}</span></div>` : ''}
        <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
        <div class="r g"><span>REFUND TOTAL</span><span>${App.ui.money(result.total)}</span></div>
        <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
        <div style="text-align:center">Items returned to stock.<br>Customer refunded ${App.ui.money(result.total)}.</div>
      </div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="print">Print</button><button class="btn btn-primary" data-a="close">Done</button>`,
    });
    m.el.querySelector('[data-a="close"]').onclick = () => m.close();
    m.el.querySelector('[data-a="print"]').onclick = async () => {
      const text = `YANKENT POS\nREFUND RECEIPT\n${result.refundTxnId}\nOriginal: ${sale.txn_id}\n${new Date().toLocaleString()}\nCashier: ${cashierName}\nAdmin: ${adminName}\nCustomer: ${sale.customer_name}\nPay: ${sale.payment_method.toUpperCase()}\n${reason ? 'Reason: ' + reason : ''}\n\nREFUND TOTAL: ${App.ui.money(result.total)}\nItems returned to stock.`;
      try { await App.printer.printTextFallback(text); } catch (e) { App.ui.toast(e.message, 'err'); }
    };
    App.ui.toast(`Refund ${result.refundTxnId} processed — ${App.ui.money(result.total)} returned, items restocked`, 'ok');
  },
};
