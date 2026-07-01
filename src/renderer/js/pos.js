'use strict';
/* POS sales screen — catalog + cart + checkout + receipt. */
window.App = window.App || {};
App.views = App.views || {};
App.cart = App.cart || [];

App.views.pos = {
  title: 'Point of Sale',
  cache: { products: [], categories: [], customers: [] },
  state: { tab: 'products', cat: 'all', q: '', customer: null, pay: 'cash', zoom: parseFloat(localStorage.getItem('posZoom') || '1'), discountOn: false },

  async render(view) {
    this.viewEl = view;
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
              <button class="btn btn-ghost btn-sm" id="posClear">Clear</button>
              <div class="zoom-ctrl">
                <button class="btn btn-ghost btn-sm" id="posZoomOut" title="Smaller text">A−</button>
                <span class="zoom-val" id="posZoomVal">100%</span>
                <button class="btn btn-ghost btn-sm" id="posZoomIn" title="Bigger text">A+</button>
              </div>
            </div>
            <div class="tabs">
              <div class="tab active" data-tab="products">Products</div>
              <div class="tab" data-tab="services">Services</div>
            </div>
            <div class="chips" id="posChips"></div>
            <div class="prod-grid" id="posGrid"></div>
          </div>
        </div>
        <div class="pos-right">
          <div class="panel">
            <div class="cust-box">
              <label class="fl">Customer</label>
              <div class="row">
                <select id="posCust" class="fill"></select>
              </div>
              <div class="credit-info hidden" id="posCredit"></div>
            </div>
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
    this._applyZoom();
    this._renderCust();
    this._renderChips();
    this._renderGrid();
    this._renderCart();
  },

  _applyZoom() {
    const catalog = this.viewEl.querySelector('.pos-catalog');
    if (catalog) catalog.style.zoom = this.state.zoom;
    const val = this.viewEl.querySelector('#posZoomVal');
    if (val) val.textContent = Math.round(this.state.zoom * 100) + '%';
  },
  _setZoom(delta) {
    const z = Math.min(1.8, Math.max(0.8, +(this.state.zoom + delta).toFixed(2)));
    this.state.zoom = z;
    localStorage.setItem('posZoom', String(z));
    this._applyZoom();
  },

  _wire() {
    const v = this.viewEl;
    const debounced = App.ui.debounce(() => this._renderGrid(), 200);
    v.querySelector('#posSearch').addEventListener('input', (e) => { this.state.q = e.target.value; debounced(); });
    v.querySelector('#posClear').onclick = () => { this.state.q = ''; v.querySelector('#posSearch').value = ''; this._renderGrid(); };
    v.querySelector('#posZoomIn').onclick = () => this._setZoom(0.1);
    v.querySelector('#posZoomOut').onclick = () => this._setZoom(-0.1);
    // Ctrl + scroll to zoom the catalog
    v.querySelector('.pos-catalog').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this._setZoom(e.deltaY < 0 ? 0.1 : -0.1);
    }, { passive: false });
    v.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
      v.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); this.state.tab = t.dataset.tab; this._renderChips(); this._renderGrid();
    });
    v.querySelector('#posCust').onchange = (e) => this._selectCustomer(+e.target.value);
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

  _renderCust() {
    const sel = this.viewEl.querySelector('#posCust');
    const opts = ['<option value="0">Walk-in Customer</option>']
      .concat(this.cache.customers.filter((c) => c.id !== 1).map((c) =>
        `<option value="${c.id}">${App.ui.esc(c.name)}${c.type === 'contractor' ? ' (Contractor)' : ''}</option>`));
    sel.innerHTML = opts.join('');
  },

  _selectCustomer(id) {
    this.state.customer = id ? this.cache.customers.find((c) => c.id === id) : null;
    const box = this.viewEl.querySelector('#posCredit');
    if (this.state.customer && this.state.customer.type === 'contractor') {
      const c = this.state.customer;
      const avail = c.credit_limit - c.credit_used;
      box.classList.remove('hidden');
      box.innerHTML = `<div><b>Contractor account</b> — limit ${App.ui.money(c.credit_limit)}</div>
        <div class="muted">Used ${App.ui.money(c.credit_used)} · Available ${App.ui.money(avail)}</div>`;
    } else box.classList.add('hidden');
    if (this.state.pay === 'account' && !(this.state.customer && this.state.customer.type === 'contractor')) this._setPay('cash');
  },

  _renderChips() {
    const el = this.viewEl.querySelector('#posChips');
    if (this.state.tab === 'services') { el.innerHTML = ''; return; }
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
        return `<div class="prod-card ${out ? 'out-of-stock' : ''}" data-id="${p.id}" style="border-left:4px solid ${col}">
          <div class="nm">${App.ui.esc(p.name)}</div>
          <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
          <div class="stk ${out ? 'low' : low ? 'low' : ''}">${out ? 'OUT OF STOCK' : 'Stock: ' + App.ui.qty(p.stock) + ' ' + App.ui.esc(p.base_unit)}${(!out && p.units && p.units.length > 1) ? ' · ' + p.units.length + ' units' : ''}</div>
        </div>`;
      }).join('');
    } else {
      el.innerHTML = list.map((p) => {
        const def = (p.units && p.units[0]) || { unit: p.base_unit, price: p.price };
        return `<div class="prod-card svc-card" data-id="${p.id}">
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
      const q = prompt(`Quantity for ${p.name} (${(p.units[0] || {}).unit || p.base_unit})?`, '1');
      if (!q) return;
      const n = parseFloat(q); if (!n || n <= 0) { App.ui.toast('Invalid quantity', 'err'); return; }
      const u = p.units[0] || { unit: p.base_unit, factor: 1, price: p.price };
      App.cart.push({ productId: p.id, sku: p.sku, name: p.name, unit: u.unit, factor: u.factor, unitPrice: u.price, qty: n, isService: true, lineType: 'service', units: p.units, base_unit: p.base_unit });
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
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    const discAmt = gross * discPct / 100;
    const total = Math.max(0, gross - discAmt);
    const vat = total - total / 1.12;
    let discLine = '';
    if (discPct > 0) {
      discLine = `<div class="r"><span class="l">Discount (${discPct}% off)</span><span>−${App.ui.money(discAmt)}</span></div>`;
    }
    this.viewEl.querySelector('#posTotals').innerHTML = `
      <div class="r"><span class="l">Materials</span><span>${App.ui.money(mat)}</span></div>
      <div class="r"><span class="l">Services</span><span>${App.ui.money(svc)}</span></div>
      <div class="r"><span class="l">VAT 12% (incl.)</span><span>${App.ui.money(vat)}</span></div>
      ${discLine}
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
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    const total = Math.max(0, gross - gross * discPct / 100);
    const pay = this.state.pay;
    const cust = this.state.customer;
    let cashHtml = '', refHtml = '';
    if (pay === 'cash') cashHtml = `<div class="field"><label class="fl">Cash Received</label><input id="payCash" type="number" step="0.01" value="${total.toFixed(2)}" autofocus></div><div id="changeBox" class="credit-info"></div>`;
    if (pay === 'card' || pay === 'ewallet') refHtml = `<div class="field"><label class="fl">Reference No.</label><input id="payRef" placeholder="Transaction ref (optional)"></div>`;
    const custName = cust ? cust.name : 'Walk-in Customer';
    const m = App.ui.modal({
      title: 'Complete Payment', wide: false,
      bodyHtml: `<div class="field"><label class="fl">Amount Due</label><input value="${App.ui.money(total)}" readonly></div>
        <div class="row gap" style="margin-bottom:10px"><span class="badge ${pay}">${pay.toUpperCase()}</span><span class="muted">${App.ui.esc(custName)}</span></div>
        ${cashHtml}${refHtml}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Confirm &amp; Print</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = () => { m.close(); this._confirm(total, pay, cust); };
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
      const res = await App.pos.sales.create(payload);
      App.ui.toast(`Sale ${res.txnId} completed ✓`, 'ok');
      // refresh cached product stock + customer credit
      this.cache.products = await App.pos.products.list({ includeServices: true });
      this.cache.customers = await App.pos.customers.list();
      App.cart = [];
      this.state.customer = null;
      this.state.discountOn = false;
      const dBtn = this.viewEl.querySelector('#posDiscount');
      if (dBtn) { dBtn.classList.remove('btn-primary'); dBtn.classList.add('btn-ghost'); dBtn.textContent = 'Discount'; }
      this.viewEl.querySelector('#posCust').value = '0';
      this.viewEl.querySelector('#posCredit').classList.add('hidden');
      this._setPay('cash');
      this._renderChips(); this._renderGrid(); this._renderCart();
      // receipt + auto-print
      await this._showReceipt(res.txnId, res.receipt);
      await App.printer.autoPrint(res.txnId);
    } catch (e) {
      App.ui.toast(e.message, 'err');
    }
  },

  async _showReceipt(txnId, receipt) {
    const text = receipt ? null : (await App.pos.printer.encodeReceipt(txnId)).text;
    const body = (receipt && receipt.items) ? this._receiptHtml(receipt) : `<pre class="receipt">${App.ui.esc(text)}</pre>`;
    const m = App.ui.modal({
      title: 'Receipt · ' + txnId, wide: true,
      bodyHtml: body,
      footerHtml: `<button class="btn btn-ghost" data-a="reprint">Reprint (Bluetooth)</button>
        <button class="btn btn-ghost" data-a="sysprint">Print (system)</button>
        <button class="btn btn-primary" data-a="close">Close</button>`,
    });
    m.el.querySelector('[data-a="close"]').onclick = () => m.close();
    m.el.querySelector('[data-a="reprint"]').onclick = async () => {
      try { if (!App.printer.isConnected()) { await App.printer.pair(); } await App.printer.printReceipt(txnId); App.ui.toast('Reprinted ✓', 'ok'); }
      catch (e) { App.ui.toast('Reprint failed: ' + e.message, 'err'); }
    };
    m.el.querySelector('[data-a="sysprint"]').onclick = async () => {
      try { await App.printer.printReceiptFallback(txnId); } catch (e) { App.ui.toast(e.message, 'err'); }
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
      <div class="r"><span>Subtotal</span><span>${App.ui.money(r.subtotal)}</span></div>
      <div class="r"><span>VAT 12%</span><span>${App.ui.money(r.vat)}</span></div>
      <div class="r" style="font-weight:800;font-size:14px;margin-top:4px"><span>TOTAL</span><span>${App.ui.money(r.total)}</span></div>
      ${r.paymentMethod === 'cash' ? `<div class="r"><span>Cash</span><span>${App.ui.money(r.tendered)}</span></div><div class="r"><span>Change</span><span>${App.ui.money(r.change)}</span></div>` : ''}
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      <div style="text-align:center">${App.ui.esc(r.footer || '').replace(/\n/g, '<br>')}</div></div>`;
  },

  // ---- Refund flow --------------------------------------------------------
  // Step 1: enter transaction ID from the receipt
  _startRefund() {
    const m = App.ui.modal({
      title: 'Process Refund',
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

  // Step 2: show the sale details + ask for admin PIN
  _showRefundSale(sale) {
    const itemsHtml = sale.items.map((i) => `<tr><td>${App.ui.esc(i.name)}</td><td class="right">${App.ui.qty(i.qty)} ${App.ui.esc(i.unit)}</td><td class="right">${App.ui.money(i.amount)}</td></tr>`).join('');
    const m = App.ui.modal({
      title: 'Refund — ' + sale.txn_id, wide: true,
      bodyHtml: `<div class="hint" style="margin-bottom:8px">
          <b>Date:</b> ${App.ui.esc(sale.datetime)} · <b>Cashier:</b> ${App.ui.esc(sale.cashier_name)} · <b>Pay:</b> ${App.ui.esc(sale.payment_method.toUpperCase())} · <b>Customer:</b> ${App.ui.esc(sale.customer_name)}
        </div>
        <table class="tbl"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead><tbody>${itemsHtml}</tbody></table>
        <div class="totals" style="border:none;padding:8px 0"><div class="r g"><span>TOTAL REFUND</span><span>${App.ui.money(sale.total)}</span></div></div>
        <div class="field"><label class="fl">Reason (optional)</label><input id="rfReason" placeholder="Customer return / wrong item / damaged"></div>
        <div class="sec-title">Admin approval required</div>
        <div class="field"><label class="fl">Admin PIN (password)</label>
          <div class="pw-field"><input id="rfAdminPin" type="password"><button type="button" class="pw-toggle" data-tgt="rfAdminPin">👁</button></div>
        </div>
        <div class="hint">Only an admin can approve refunds. The cashier cannot refund alone.</div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-danger" data-a="refund">Approve &amp; Process Refund</button>`,
    });
    m.el.querySelectorAll('.pw-toggle').forEach((b) => {
      b.onclick = () => { const inp = m.el.querySelector('#' + b.dataset.tgt); const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.textContent = show ? '🙈' : '👁'; };
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="refund"]').onclick = async () => {
      const pin = m.el.querySelector('#rfAdminPin').value;
      if (!pin) { App.ui.toast('Enter admin PIN', 'err'); return; }
      const btn = m.el.querySelector('[data-a="refund"]'); btn.disabled = true; btn.textContent = 'Processing…';
      try {
        // Verify admin PIN
        const adminRes = await App.pos.refunds.verifyAdmin(pin);
        if (!adminRes.ok) { App.ui.toast('Invalid admin PIN', 'err'); btn.disabled = false; btn.textContent = 'Approve & Process Refund'; return; }
        // Process the refund
        const reason = m.el.querySelector('#rfReason').value.trim();
        const result = await App.pos.refunds.process({ txnId: sale.txn_id, adminName: adminRes.admin.name, adminId: adminRes.admin.id, reason });
        m.close();
        // Show refund receipt
        this._showRefundReceipt(sale, result, reason, adminRes.admin.name);
        // Refresh stock
        this.cache.products = await App.pos.products.list({ includeServices: true });
        this._renderGrid();
      } catch (e) { App.ui.toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Approve & Process Refund'; }
    };
  },

  // Step 3: show the refund receipt confirmation
  _showRefundReceipt(sale, result, reason, adminName) {
    const m = App.ui.modal({
      title: 'Refund Processed ✓', wide: true,
      bodyHtml: `<div class="receipt"><div class="store">YANKENT POS</div>
        <div style="text-align:center;color:#666;font-size:10px">REFUND RECEIPT</div>
        <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
        <div class="r"><span>Refund ID</span><span>${App.ui.esc(result.refundTxnId)}</span></div>
        <div class="r"><span>Original Txn</span><span>${App.ui.esc(sale.txn_id)}</span></div>
        <div class="r"><span>Date</span><span>${new Date().toLocaleString()}</span></div>
        <div class="r"><span>Cashier</span><span>${App.ui.esc(App.current.user.full_name)}</span></div>
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
      const text = `YANKENT POS\nREFUND RECEIPT\n${result.refundTxnId}\nOriginal: ${sale.txn_id}\n${new Date().toLocaleString()}\nCashier: ${App.current.user.full_name}\nAdmin: ${adminName}\nCustomer: ${sale.customer_name}\nPay: ${sale.payment_method.toUpperCase()}\n${reason ? 'Reason: ' + reason : ''}\n\nREFUND TOTAL: ${App.ui.money(result.total)}\nItems returned to stock.`;
      try { await App.printer.printTextFallback(text); } catch (e) { App.ui.toast(e.message, 'err'); }
    };
    App.ui.toast(`Refund ${result.refundTxnId} processed — ${App.ui.money(result.total)} returned, items restocked`, 'ok');
  },
};
