'use strict';
/* POS sales screen — catalog + cart + checkout + receipt. */
window.App = window.App || {};
App.views = App.views || {};
App.cart = App.cart || [];

App.views.pos = {
  title: 'Point of Sale',
  cache: { products: [], categories: [], customers: [] },
  state: { tab: 'products', cat: 'all', q: '', customer: null, pay: 'cash', dueDate: '', discountOn: false, chipsOpen: false },
  // Lazy grid: render the first batch, append more as the cashier scrolls.
  _gridList: [],
  _gridShown: 0,
  _gridBatch: 100,
  _gridObserver: null,

  async render(view) {
    const generation = App.captureSessionGeneration();
    this.viewEl = view;
    view.classList.add('view-pos');
    // Always fetch fresh data so admin changes (price, stock, categories) sync immediately.
    const [products, categories, customers] = await Promise.all([
      App.pos.products.list({ includeServices: true }),
      App.pos.categories.list(),
      App.pos.loans.listCustomers({ activeOnly: true }),
    ]);
    if (!App.isSessionGenerationCurrent(generation) || this.viewEl !== view) return;
    this.cache = { products, categories, customers };
    if (this.state.customer) {
      this.state.customer = customers.find((customer) => customer.id === this.state.customer.id) || null;
    }
    if (this.state.pay === 'account' && !this.state.customer) this.state.pay = 'cash';
    const productsActive = this.state.tab !== 'services';
    const payment = this.state.pay || 'cash';
    const customerOptions = customers.map((customer) => `<option value="${customer.id}" ${this.state.customer && this.state.customer.id === customer.id ? 'selected' : ''}>${App.ui.esc(customer.name)} — ${App.ui.money(customer.available_credit)} available</option>`).join('');
    view.innerHTML = `
      <div class="pos-grid">
        <div class="pos-left">
          <div class="panel pos-catalog">
            <div class="search-row">
              <input id="posSearch" value="${App.ui.esc(this.state.q || '')}" placeholder="Search SKU / item name…" autocomplete="off" aria-label="Search products by SKU or item name">
            </div>
            <div class="tabs" id="posTabs" role="tablist" aria-label="Catalog type">
              <button type="button" class="tab ${productsActive ? 'active' : ''}" data-tab="products" role="tab" aria-selected="${productsActive}" tabindex="${productsActive ? '0' : '-1'}">Products <span class="tab-count" id="posCountProducts">0</span></button>
              <button type="button" class="tab ${productsActive ? '' : 'active'}" data-tab="services" role="tab" aria-selected="${!productsActive}" tabindex="${productsActive ? '-1' : '0'}">Services <span class="tab-count" id="posCountServices">0</span></button>
            </div>
            <div class="chips-wrap" id="posChipsWrap" hidden>
              <button class="chips-toggle" id="posChipsToggle" type="button" aria-expanded="false">
                <span class="chips-toggle-arrow">▸</span><span>Categories</span>
              </button>
              <div class="chips" id="posChips" hidden></div>
            </div>
            <div class="prod-grid" id="posGrid" aria-label="Product catalog"></div>
          </div>
        </div>
        <div class="pos-right">
          <div class="panel" aria-label="Current sale">
            <div class="panel-h">Current Sale <small><span id="posCount" aria-live="polite">0</span> lines</small></div>
            <div class="cart" id="posCart"></div>
            <div class="totals" id="posTotals"></div>
            <div class="pos-credit-select" aria-label="Credit customer">
              <div class="pos-credit-row">
                <label for="posCustomer">Customer / Company</label>
                <button type="button" class="btn btn-sm btn-ghost" id="posAddCustomer">Add</button>
              </div>
              <select id="posCustomer">
                <option value="">Walk-in Customer</option>
                ${customerOptions}
              </select>
              <div class="pos-credit-meta" id="posCreditMeta"></div>
              <div class="pos-due-field" id="posDueField" hidden>
                <label for="posDueDate">Loan due date</label>
                <input id="posDueDate" type="date" min="${App.ui.todayISO()}" value="${App.ui.esc(this.state.dueDate || '')}">
              </div>
            </div>
            <div class="pay-grid" id="posPay" role="group" aria-label="Payment method">
              <button type="button" class="${payment === 'cash' ? 'active' : ''}" data-pay="cash" aria-pressed="${payment === 'cash'}">Cash</button>
              <button type="button" class="${payment === 'card' ? 'active' : ''}" data-pay="card" aria-pressed="${payment === 'card'}">Card</button>
              <button type="button" class="${payment === 'ewallet' ? 'active' : ''}" data-pay="ewallet" aria-pressed="${payment === 'ewallet'}">E-Wallet</button>
              <button type="button" class="${payment === 'account' ? 'active' : ''}" data-pay="account" aria-pressed="${payment === 'account'}">On-Account</button>
            </div>
            <div class="ck">
              <button type="button" class="btn btn-ghost" id="posVoid">Void</button>
              <button type="button" class="btn btn-ghost" id="posDiscount" title="Apply admin-set discount %">Discount</button>
              <button type="button" class="btn btn-ghost" id="posRefund" title="Refund a completed sale; administrator approval is required">Refund sale…</button>
              <button type="button" class="btn btn-primary" id="posCharge">Charge ₱0.00</button>
            </div>
          </div>
        </div>
      </div>`;

    this._wire();
    this._renderChips();
    this._renderGrid();
    this._renderCart();
    this._renderCustomerCredit();
  },

  _wire() {
    const v = this.viewEl;
    const debounced = App.ui.debounce(() => this._renderGrid(), 300);
    v.querySelector('#posSearch').addEventListener('input', (e) => { this.state.q = e.target.value; debounced(); });
    const tabs = [...v.querySelectorAll('#posTabs .tab')];
    const selectTab = (t) => {
      tabs.forEach((x) => {
        const active = x === t;
        x.classList.toggle('active', active);
        x.setAttribute('aria-selected', String(active));
        x.tabIndex = active ? 0 : -1;
      });
      this.state.tab = t.dataset.tab;
      // Clear search when switching Products ↔ Services so a product search
      // string does not leave the Services tab empty while the badge count
      // still shows a number (the count is unfiltered).
      this.state.q = '';
      const search = v.querySelector('#posSearch');
      if (search) search.value = '';
      this._renderChips();
      this._renderGrid();
    };
    tabs.forEach((t) => t.onclick = () => selectTab(t));
    v.querySelector('#posTabs').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      const next = e.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
      selectTab(tabs[next]); tabs[next].focus();
    });
    const toggle = v.querySelector('#posChipsToggle');
    if (toggle) toggle.onclick = () => { this.state.chipsOpen = !this.state.chipsOpen; this._renderChips(); };
    const customerSelect = v.querySelector('#posCustomer');
    customerSelect.onchange = () => {
      const previousCustomerId = this.state.customer ? this.state.customer.id : null;
      const id = Number(customerSelect.value);
      this.state.customer = this.cache.customers.find((customer) => customer.id === id) || null;
      const nextCustomerId = this.state.customer ? this.state.customer.id : null;
      if (previousCustomerId !== nextCustomerId) this.state.dueDate = '';
      if (!this.state.customer && this.state.pay === 'account') this._setPay('cash');
      this._renderCustomerCredit();
    };
    v.querySelector('#posAddCustomer').onclick = () => {
      if (!App.views.utang || typeof App.views.utang._profileForm !== 'function') return;
      const generation = App.captureSessionGeneration();
      App.views.utang._profileForm(null, async (customer) => {
        if (!App.isSessionGenerationCurrent(generation)) return;
        const customers = await App.pos.loans.listCustomers({ activeOnly: true });
        if (!App.isSessionGenerationCurrent(generation) || this.viewEl !== v || !customerSelect.isConnected) return;
        this.cache.customers = customers;
        this.state.customer = this.cache.customers.find((entry) => entry.id === customer.id) || null;
        this.state.dueDate = '';
        customerSelect.innerHTML = '<option value="">Walk-in Customer</option>' + this.cache.customers.map((entry) => `<option value="${entry.id}">${App.ui.esc(entry.name)} — ${App.ui.money(entry.available_credit)} available</option>`).join('');
        this._renderCustomerCredit();
      });
    };
    v.querySelector('#posDueDate').onchange = (event) => { this.state.dueDate = event.target.value; };
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
    // Event delegation: one click listener on the grid instead of one per card.
    const grid = v.querySelector('#posGrid');
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.prod-card');
      if (card) this._add(+card.dataset.id);
    });
    // keyboard: Enter in search adds first match
    v.querySelector('#posSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = v.querySelector('#posGrid .prod-card:not(:disabled)');
        if (first) first.click();
        else App.ui.toast('No in-stock item matches this search', 'err');
      }
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
    const all = `<button type="button" class="chip ${this.state.cat === 'all' ? 'active' : ''}" data-cat="all" aria-pressed="${this.state.cat === 'all'}">All</button>`;
    el.innerHTML = all + cats.map((c) => {
      const col = App.catColor(c.name);
      const isActive = this.state.cat === c.name;
      return `<button type="button" class="chip ${isActive ? 'active' : ''}" data-cat="${App.ui.esc(c.name)}" aria-pressed="${isActive}" style="${isActive ? `background:${col};border-color:${col}` : `border-left:3px solid ${col}`}">${App.ui.esc(c.name)}</button>`;
    }).join('');
    el.querySelectorAll('.chip').forEach((ch) => ch.onclick = () => { this.state.cat = ch.dataset.cat; this._renderChips(); this._renderGrid(); });
  },

  _cardHtml(p) {
    const def = (p.units && p.units[0]) || { unit: p.base_unit || 'svc', price: p.price, factor: 1 };
    if (this.state.tab === 'products' && !App.isService(p)) {
      const low = p.stock <= (p.low || 10);
      const out = p.stock <= 0;
      const col = App.catColor(p.category);
      const cls = out ? 'out-of-stock' : 'in-stock';
      const stockLabel = out ? 'out of stock' : `stock ${App.ui.qty(p.stock)} ${p.base_unit}`;
      return `<button type="button" class="prod-card ${cls}" data-id="${p.id}" style="border-left:4px solid ${col}" title="${App.ui.esc(p.name)}" aria-label="${App.ui.esc(`${p.name}, ${App.ui.money(def.price)} per ${def.unit}, ${stockLabel}`)}"${out ? ' disabled aria-disabled="true"' : ''}>
        <div class="nm">${App.ui.esc(p.name)}</div>
        <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
        <div class="stk ${out ? 'low' : low ? 'low' : ''}">${out ? 'OUT OF STOCK' : 'Stock: ' + App.ui.qty(p.stock) + ' ' + App.ui.esc(p.base_unit)}${(!out && p.units && p.units.length > 1) ? ' · ' + p.units.length + ' units' : ''}</div>
      </button>`;
    }
    // Services: never treat as out-of-stock (stock is always 0 by design).
    return `<button type="button" class="prod-card svc-card" data-id="${p.id}" title="${App.ui.esc(p.name)}" aria-label="${App.ui.esc(`${p.name}, service, ${App.ui.money(def.price)} per ${def.unit}`)}">
      <div class="nm">${App.ui.esc(p.name)}</div>
      <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
      <div class="stk">Service</div>
    </button>`;
  },

  _renderGrid() {
    const el = this.viewEl.querySelector('#posGrid');
    // Update tab counts (total products / total services in cache).
    const all = this.cache.products || [];
    const prodCount = all.filter((p) => !App.isService(p)).length;
    const svcCount = all.filter((p) => App.isService(p)).length;
    const pc = this.viewEl.querySelector('#posCountProducts');
    const sc = this.viewEl.querySelector('#posCountServices');
    if (pc) pc.textContent = prodCount;
    if (sc) sc.textContent = svcCount;
    const q = this.state.q.toLowerCase().trim();
    let list = this.cache.products || [];
    if (this.state.tab === 'products') list = list.filter((p) => !App.isService(p));
    else list = list.filter((p) => App.isService(p));
    if (this.state.tab === 'products' && this.state.cat !== 'all') list = list.filter((p) => p.category === this.state.cat);
    if (q) {
      list = list.filter((p) => {
        const sku = String(p.sku || '').toLowerCase();
        const name = String(p.name || '').toLowerCase();
        return sku.includes(q) || name.includes(q);
      });
    }
    // Reset the lazy-load state for the new filtered list.
    this._stopGridObserver();
    this._gridList = list;
    this._gridShown = 0;
    el.scrollTop = 0;
    if (!list.length) {
      const emptyMsg = this.state.tab === 'services'
        ? (q ? 'No services match your search.' : 'No services yet. Add one under Products → + Add Service.')
        : 'No items found.';
      el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }
    // Render only the first batch — the rest stream in as the cashier scrolls.
    const n = Math.min(this._gridBatch, list.length);
    el.innerHTML = list.slice(0, n).map((p) => this._cardHtml(p)).join('');
    this._gridShown = n;
    this._startGridObserver();
  },

  // Append the next batch when the sentinel nears the viewport.
  _startGridObserver() {
    const el = this.viewEl.querySelector('#posGrid');
    if (this._gridShown >= this._gridList.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'grid-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px';
    el.appendChild(sentinel);
    this._gridObserver = new IntersectionObserver((entries) => {
      if (!entries[0] || !entries[0].isIntersecting) return;
      this._stopGridObserver();
      const start = this._gridShown;
      const end = Math.min(start + this._gridBatch, this._gridList.length);
      const html = this._gridList.slice(start, end).map((p) => this._cardHtml(p)).join('');
      el.insertAdjacentHTML('beforeend', html);
      this._gridShown = end;
      this._startGridObserver();
    }, { root: el, rootMargin: '300px 0px' });
    this._gridObserver.observe(sentinel);
  },

  _stopGridObserver() {
    if (this._gridObserver) { this._gridObserver.disconnect(); this._gridObserver = null; }
    const el = this.viewEl && this.viewEl.querySelector('#posGrid');
    if (el) { const s = el.querySelector('.grid-sentinel'); if (s) s.remove(); }
  },

  resetSessionState() {
    App.cart = [];
    this.state = {
      tab: 'products', cat: 'all', q: '', customer: null, pay: 'cash',
      dueDate: '', discountOn: false, chipsOpen: false,
    };
    this.cache = { products: [], categories: [], customers: [] };
    this._gridList = [];
    this._gridShown = 0;
    this._stopGridObserver();
  },

  destroy() { this._stopGridObserver(); },

  _add(id) {
    const p = this.cache.products.find((x) => x.id === id);
    if (!p) return;
    if (App.isService(p)) {
      // Use a styled modal instead of the blocking native prompt() — the
      // native prompt is theme-inconsistent and can be disabled by sandbox
      // configs, which would silently break adding services to the cart.
      const units = (p.units && p.units.length) ? p.units : [{ unit: p.base_unit || 'svc', factor: 1, price: p.price }];
      const m = App.ui.modal({
        title: 'Quantity — ' + p.name, closeOnOverlay: false,
        bodyHtml: `<div class="field"><label class="fl">Quantity (${(units[0] || {}).unit || p.base_unit || 'svc'})</label><input id="svcQty" type="number" step="0.01" value="1" autofocus></div>`,
        footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Add to cart</button>`,
      });
      m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
      const input = m.el.querySelector('#svcQty');
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('[data-a="ok"]').click(); });
      m.el.querySelector('[data-a="ok"]').onclick = () => {
        const n = parseFloat(input.value);
        if (!n || n <= 0) { App.ui.toast('Invalid quantity', 'err'); return; }
        const u = units[0] || { unit: p.base_unit || 'svc', factor: 1, price: p.price };
        App.cart.push({ productId: p.id, sku: p.sku, name: p.name, unit: u.unit, factor: u.factor || 1, unitPrice: u.price, qty: n, isService: true, lineType: 'service', units, base_unit: p.base_unit || 'svc' });
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
          ? `<select data-field="unit" aria-label="Unit for ${App.ui.esc(i.name)}">${i.units.map((u) => `<option ${u.unit === i.unit ? 'selected' : ''}>${App.ui.esc(u.unit)}</option>`).join('')}</select>`
          : `<span class="muted">${App.ui.esc(i.unit)}</span>`;
        return `<div class="cart-row ${i.isService ? 'svc' : ''}" data-idx="${idx}">
          <div>
            <div class="nm">${App.ui.esc(i.name)}${i.isService ? ' <span class="badge svc">svc</span>' : ''}</div>
            <div class="meta">${App.ui.money(i.unitPrice)} / ${App.ui.esc(i.unit)}</div>
          </div>
          <div class="qty">
            <button type="button" data-act="minus" aria-label="Decrease quantity for ${App.ui.esc(i.name)}">−</button>
            <input data-field="qty" type="number" step="0.001" value="${App.ui.qty(i.qty)}" aria-label="Quantity for ${App.ui.esc(i.name)}">
            <button type="button" data-act="plus" aria-label="Increase quantity for ${App.ui.esc(i.name)}">+</button>
          </div>
          <div class="amt">${App.ui.money(amt)} <button type="button" class="rm" data-act="rm" aria-label="Remove ${App.ui.esc(i.name)} from cart">✕</button>
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
    // Catalog prices are VAT-inclusive. Split VAT out for display without
    // adding it again to the amount the customer pays.
    const total = Math.max(0, gross - discAmt);
    const subtotal = total / (1 + vatRate / 100);
    const vat = total - subtotal;
    let discLine = '';
    if (discPct > 0) {
      discLine = `<div class="r"><span class="l">Discount (${discPct}% off)</span><span>−${App.ui.money(discAmt)}</span></div>`;
    }
    this.viewEl.querySelector('#posTotals').innerHTML = `
      <div class="r"><span class="l">Materials</span><span>${App.ui.money(mat)}</span></div>
      <div class="r"><span class="l">Services</span><span>${App.ui.money(svc)}</span></div>
      <div class="r"><span class="l">Subtotal (excl. VAT)</span><span>${App.ui.money(subtotal)}</span></div>
      ${discLine}
      <div class="r"><span class="l">VAT ${vatRate}% (included)</span><span>${App.ui.money(vat)}</span></div>
      <div class="r g"><span>TOTAL</span><span>${App.ui.money(total)}</span></div>`;
    this.viewEl.querySelector('#posCount').textContent = App.cart.length;
    this.viewEl.querySelector('#posCharge').textContent = 'Charge ' + App.ui.money(total);
  },

  _renderCustomerCredit() {
    if (!this.viewEl) return;
    const select = this.viewEl.querySelector('#posCustomer');
    const meta = this.viewEl.querySelector('#posCreditMeta');
    const dueField = this.viewEl.querySelector('#posDueField');
    const dueInput = this.viewEl.querySelector('#posDueDate');
    const customer = this.state.customer;
    if (select) select.value = customer ? String(customer.id) : '';
    if (meta) {
      meta.innerHTML = customer
        ? `<span>Outstanding <b>${App.ui.money(customer.outstanding)}</b></span><span>Available <b>${App.ui.money(customer.available_credit)}</b></span>`
        : '<span>Select a credit customer to use On-Account.</span>';
    }
    const account = this.state.pay === 'account';
    if (dueField) dueField.hidden = !account;
    if (dueInput) {
      dueInput.required = account;
      dueInput.value = this.state.dueDate || '';
    }
  },

  _setPay(p) {
    if (p === 'account' && !(this.state.customer && this.state.customer.type === 'contractor' && this.state.customer.active)) {
      App.ui.toast('On-Account requires an active credit customer', 'err'); return;
    }
    this.state.pay = p;
    this.viewEl.querySelectorAll('#posPay button').forEach((b) => {
      const active = b.dataset.pay === p;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    this._renderCustomerCredit();
  },

  _void() {
    if (!App.cart.length) return;
    App.ui.confirm('Void the entire current sale?').then((ok) => {
      if (ok) {
        this._resetCartState();
        App.ui.toast('Sale voided');
      }
    });
  },

  _checkout() {
    if (!App.cart.length) { App.ui.toast('Cart is empty', 'err'); return; }
    const gross = App.cart.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const vatRate = parseFloat((App.settingsCache || {}).vat_rate) || 12;
    const discPct = this.state.discountOn ? (parseFloat((App.settingsCache || {}).discount_percent) || 0) : 0;
    // Prices already include VAT; checkout must not add it a second time.
    const total = Math.max(0, gross - gross * discPct / 100);
    const pay = this.state.pay;
    const cust = this.state.customer;
    const dueDate = pay === 'account' ? String(this.state.dueDate || '') : '';
    if (pay === 'account' && !dueDate) {
      App.ui.toast('Select a loan due date before checkout', 'err');
      const input = this.viewEl.querySelector('#posDueDate');
      if (input) input.focus();
      return;
    }
    let cashHtml = '', refHtml = '';
    if (pay === 'cash') cashHtml = `<div class="field"><label class="fl">Cash Received</label><input id="payCash" type="number" step="0.01" value="${total.toFixed(2)}" autofocus></div><div id="changeBox" class="credit-info"></div>`;
    if (pay === 'card' || pay === 'ewallet') refHtml = `<div class="field"><label class="fl">Reference No.</label><input id="payRef" placeholder="Transaction ref (optional)"></div>`;
    const custName = cust ? cust.name : 'Walk-in Customer';
    const m = App.ui.modal({
      title: 'Complete Payment', wide: false, closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Amount Due (incl. VAT ${vatRate}%)</label><input value="${App.ui.money(total)}" readonly></div>
        <div class="row gap" style="margin-bottom:10px"><span class="badge ${pay}">${pay.toUpperCase()}</span><span class="muted">${App.ui.esc(custName)}</span></div>
        ${pay === 'account' ? `<div class="credit-info">Loan due date: <b>${App.ui.esc(dueDate)}</b></div>` : ''}
        ${cashHtml}${refHtml}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Confirm &amp; Print</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Processing…'; btn.classList.add('is-printing');
      m.close();
      this._confirm(total, pay, cust, dueDate);
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

  async _confirm(total, pay, cust, dueDate) {
    const generation = App.captureSessionGeneration();
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
      dueDate: pay === 'account' ? dueDate : null,
      amountTendered: pay === 'cash' ? total : 0,
      discount: discAmt,
      reference: '',
    };
    try {
      // Create a PENDING sale — stock is NOT deducted yet.  The sale is
      // only committed (stock deducted) when the cashier clicks PRINT on
      // the receipt modal.  Closing the modal without printing voids it.
      const res = await App.pos.sales.create(payload);
      if (!App.isSessionGenerationCurrent(generation)) return;
      App.ui.toast(`Sale ${res.txnId} — click PRINT to complete`, 'ok');
      await this._showReceipt(res.txnId, res.receipt, generation);
    } catch (e) {
      if (App.isSessionGenerationCurrent(generation)) App.ui.toast(e.message, 'err');
    }
  },

  _resetCartState() {
    App.cart = [];
    this.state.customer = null;
    this.state.dueDate = '';
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

  async _showReceipt(txnId, receipt, generation = App.captureSessionGeneration()) {
    const text = receipt ? null : (await App.pos.printer.encodeReceipt(txnId)).text;
    if (!App.isSessionGenerationCurrent(generation)) return;
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
        if (!App.isSessionGenerationCurrent(generation)) return;
        // 2. Print the receipt — Bluetooth if connected, else system printer.
        //    _printWithRetry auto-reconnects once if the printer dropped
        //    (e.g. USB cable was unplugged and re-plugged).
        await this._printWithRetry(txnId);
        if (!App.isSessionGenerationCurrent(generation)) return;
        App.ui.toast('Sale completed ✓', 'ok');
        // 3. Refresh cached product stock and customer credit now that the
        //    commit is durable, but never write the response into a new session.
        const [products, customers] = await Promise.all([
          App.pos.products.list({ includeServices: true }),
          App.pos.loans.listCustomers({ activeOnly: true }),
        ]);
        if (!App.isSessionGenerationCurrent(generation)) return;
        this.cache.products = products;
        this.cache.customers = customers;
        // 4. Close modal + reset cart for the next sale.
        m.close();
        this._resetCartState();
      } catch (err) {
        if (!App.isSessionGenerationCurrent(generation)) return;
        // If commit succeeded but print failed, the sale is already
        // completed — offer a reprint rather than leaving the cashier
        // stuck on a disabled PRINT button.
        if (committed) {
          App.ui.toast('Sale completed but printing failed — click PRINT again to reprint', 'err');
          btn.textContent = 'REPRINT'; btn.classList.remove('is-printing');
          // On a successful reprint, close + reset cart.
          btn.onclick = async () => {
            btn.disabled = true; btn.textContent = 'Printing…'; btn.classList.add('is-printing');
            try {
              await this._printWithRetry(txnId);
              if (!App.isSessionGenerationCurrent(generation)) return;
              App.ui.toast('Reprinted ✓', 'ok');
              m.close(); this._resetCartState();
            } catch (e2) {
              if (!App.isSessionGenerationCurrent(generation)) return;
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
        if (!App.isSessionGenerationCurrent(generation)) return;
        // Reset sale-specific state (keep cart items for retry).
        this.state.discountOn = false;
        this.state.customer = null;
        this.state.dueDate = '';
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
      ${r.paymentMethod === 'account' && r.dueDate ? `<div class="r"><span>Due</span><span>${App.ui.esc(r.dueDate)}</span></div>` : ''}
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      ${lines}
      <hr style="border:none;border-top:1px dashed #ccc;margin:8px 0">
      <div class="r"><span>Subtotal (excl. VAT)</span><span>${App.ui.money(r.subtotal)}</span></div>
      ${r.discount > 0 ? `<div class="r"><span>Discount</span><span>−${App.ui.money(r.discount)}</span></div>` : ''}
      ${r.deliveryFee > 0 ? `<div class="r"><span>Delivery</span><span>${App.ui.money(r.deliveryFee)}</span></div>` : ''}
      ${r.vat > 0 || (r.vatRate ?? 12) > 0 ? `<div class="r"><span>VAT ${r.vatRate ?? 12}% (included)</span><span>${App.ui.money(r.vat)}</span></div>` : ''}
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

  // Step 2: show sale details and collect a reason. Cashiers must obtain a
  // one-use administrator approval before the main process accepts a refund.
  _showRefundSale(sale) {
    const itemsHtml = sale.items.map((i) => `<tr><td>${App.ui.esc(i.name)}</td><td class="right">${App.ui.qty(i.qty)} ${App.ui.esc(i.unit)}</td><td class="right">${App.ui.money(i.amount)}</td></tr>`).join('');
    const isAdmin = App.current.user && App.current.user.role === 'admin';
    const approvalHtml = isAdmin
      ? `<div class="refund-approval-note"><b>Administrator approval</b><span>You are approving this refund as ${App.ui.esc(App.current.user.full_name)}.</span></div>`
      : `<div class="refund-approval-note"><b>Administrator approval required</b><span>Ask an administrator to enter their password below. Approval is valid for this refund only.</span></div>
        <div class="field"><label class="fl" for="rfAdminPin">Administrator password</label><input id="rfAdminPin" type="password" autocomplete="current-password"></div>`;
    const m = App.ui.modal({
      title: 'Refund — ' + sale.txn_id, wide: true, closeOnOverlay: false,
      bodyHtml: `<div class="hint" style="margin-bottom:8px">
          <b>Date:</b> ${App.ui.esc(sale.datetime)} · <b>Cashier:</b> ${App.ui.esc(sale.cashier_name)} · <b>Pay:</b> ${App.ui.esc(sale.payment_method.toUpperCase())} · <b>Customer:</b> ${App.ui.esc(sale.customer_name)}
        </div>
        <table class="tbl"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead><tbody>${itemsHtml}</tbody></table>
        <div class="totals" style="border:none;padding:8px 0"><div class="r g"><span>TOTAL REFUND</span><span>${App.ui.money(sale.total)}</span></div></div>
        <div class="field"><label class="fl" for="rfReason">Refund reason</label><input id="rfReason" placeholder="Customer return / wrong item / damaged" required></div>
        ${approvalHtml}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-danger" data-a="refund">${isAdmin ? 'Approve &amp; refund' : 'Verify &amp; refund'}</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="refund"]').onclick = async () => {
      const reason = m.el.querySelector('#rfReason').value.trim();
      if (reason.length < 3) { App.ui.toast('Enter a refund reason', 'err'); m.el.querySelector('#rfReason').focus(); return; }
      const pin = m.el.querySelector('#rfAdminPin');
      if (!isAdmin && !pin.value) { App.ui.toast('Administrator password is required', 'err'); pin.focus(); return; }
      const btn = m.el.querySelector('[data-a="refund"]'); btn.disabled = true; btn.textContent = 'Processing…';
      try {
        let approvalToken;
        if (!isAdmin) {
          const approval = await App.pos.refunds.verifyAdmin(pin.value, sale.txn_id);
          if (!approval || !approval.ok || !approval.approvalToken) throw new Error('Administrator password is incorrect');
          approvalToken = approval.approvalToken;
        }
        const result = await App.pos.refunds.process({ txnId: sale.txn_id, reason, approvalToken });
        m.close();
        // Show refund receipt
        this._showRefundReceipt(sale, result, reason, result.approvedBy || 'Administrator');
        // Refresh stock
        this.cache.products = await App.pos.products.list({ includeServices: true });
        this._renderGrid();
      } catch (e) {
        App.ui.toast(e.message, 'err');
        if (pin) { pin.value = ''; pin.focus(); }
        btn.disabled = false; btn.textContent = isAdmin ? 'Approve & refund' : 'Verify & refund';
      }
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
