'use strict';
/* Admin: product catalog & inventory management. */
window.App = window.App || {};
App.views = App.views || {};

App.views.products = {
  title: 'Products & Inventory',
  cache: { products: [], categories: [] },
  q: '',
  cat: 'all',
  chipsOpen: false,

  async render(view) {
    this.viewEl = view;
    this.q = '';
    await this._load();
    view.innerHTML = `
      <div class="toolbar">
        <input id="pSearch" placeholder="Search name…" class="fill" style="max-width:300px">
        <div class="fill"></div>
        <button class="btn btn-ghost btn-sm" id="catManage">Manage Categories</button>
        <button class="btn btn-ghost btn-sm" id="pImportCatalog" title="Bulk-import the saved product catalog (245 items, ₱0 price, 0 stock)">Import Catalog</button>
        <button class="btn btn-danger btn-sm" id="pDeleteAll" title="Erase ALL products (and their units / stock movements). Category names are preserved.">Delete All Products</button>
        <button class="btn btn-primary btn-sm" id="pAdd">+ Add Product</button>
        <button class="btn btn-primary btn-sm" id="pAddSvc" title="Add a service (labor, delivery, etc.) — no stock tracking">+ Add Service</button>
      </div>
      <div class="chips-wrap" id="pChipsWrap">
        <button class="chips-toggle" id="pChipsToggle" type="button" aria-expanded="false">
          <span class="chips-toggle-arrow">▸</span><span>Categories</span>
        </button>
        <div class="chips" id="pChips" hidden></div>
      </div>
      <div class="prod-grid" id="pGrid" style="max-height:calc(100vh - 210px)"></div>`;
    this._wire();
    this._renderChips();
    this._renderGrid();
  },

  async _load() {
    const [products, categories] = await Promise.all([
      App.pos.products.list({ includeServices: true, q: this.q || undefined }),
      App.pos.categories.withCounts(),
    ]);
    this.cache = { products, categories };
  },

  _wire() {
    const v = this.viewEl;
    const d = App.ui.debounce(async () => { await this._load(); this._renderChips(); this._renderGrid(); }, 250);
    v.querySelector('#pSearch').addEventListener('input', (e) => { this.q = e.target.value; d(); });
    v.querySelector('#pAdd').onclick = () => this._edit(null);
    v.querySelector('#pAddSvc').onclick = () => this._editService(null);
    v.querySelector('#catManage').onclick = () => this._catModal();
    v.querySelector('#pDeleteAll').onclick = () => this._deleteAll();
    v.querySelector('#pImportCatalog').onclick = () => this._importCatalog();
    const toggle = v.querySelector('#pChipsToggle');
    if (toggle) toggle.onclick = () => { this.chipsOpen = !this.chipsOpen; this._renderChips(); };
    v.querySelector('#pChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]'); if (!chip) return;
      this.cat = chip.dataset.cat; this._renderChips(); this._renderGrid();
    });
    v.querySelector('#pGrid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-id]'); if (!card) return;
      const id = +card.dataset.id; if (!id) return;
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const isSvc = this.cache.products.find((x) => x.id === id)?.is_service;
      if (act === 'edit') { if (isSvc) this._editService(id); else this._edit(id); }
      else if (act === 'stock') this._stock(id);
      else if (act === 'del') this._del(id);
    });
  },

  _renderChips() {
    const wrap = this.viewEl.querySelector('#pChipsWrap');
    const toggle = this.viewEl.querySelector('#pChipsToggle');
    const el = this.viewEl.querySelector('#pChips');
    if (!wrap || !el) return;
    const open = !!this.chipsOpen;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.chips-toggle-arrow').textContent = open ? '▾' : '▸';
    el.hidden = !open;
    if (!open) return;
    const cats = this.cache.categories;
    const all = `<div class="chip ${this.cat === 'all' ? 'active' : ''}" data-cat="all">All <span class="muted" style="font-weight:400">(${this.cache.products.length})</span></div>`;
    el.innerHTML = all + cats.map((c) => {
      const col = App.catColor(c.name);
      const isActive = this.cat === c.name;
      return `<div class="chip ${isActive ? 'active' : ''}" data-cat="${App.ui.esc(c.name)}" style="${isActive ? `background:${col};border-color:${col}` : `border-left:3px solid ${col}`}">${App.ui.esc(c.name)} <span style="font-weight:400;opacity:.7">${c.productCount || 0}</span></div>`;
    }).join('');
  },

  _renderGrid() {
    const el = this.viewEl.querySelector('#pGrid');
    const q = this.q.toLowerCase().trim();
    let list = this.cache.products;
    if (this.cat !== 'all') list = list.filter((p) => p.category === this.cat);
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    if (!list.length) { el.innerHTML = '<div class="empty-state">No products found.</div>'; return; }
    el.innerHTML = list.map((p) => {
      const def = (p.units && p.units[0]) || { unit: p.base_unit, price: p.price };
      const low = !p.is_service && p.stock <= (p.low || 10);
      const col = App.catColor(p.category);
      const svcTag = p.is_service ? '<span class="badge svc">svc</span>' : '';
      const lowTag = low ? '<span class="badge low">low</span>' : '';
      return `<div class="prod-card" data-id="${p.id}" style="border-left:4px solid ${col}">
        <div class="nm">${App.ui.esc(p.name)} ${svcTag}${lowTag}</div>
        <div class="pr">${App.ui.money(def.price)} <small>/${App.ui.esc(def.unit)}</small></div>
        <div class="stk ${low ? 'low' : ''}">${p.is_service ? 'Service' : 'Stock: ' + App.ui.qty(p.stock) + ' ' + App.ui.esc(p.base_unit)}${(p.units && p.units.length > 1) ? ' · ' + p.units.length + ' units' : ''}</div>
        <div class="prod-actions">
          <button class="btn btn-sm btn-edit" data-act="edit">Edit</button>
          ${p.is_service ? '' : '<button class="btn btn-sm btn-stock" data-act="stock">Stock</button>'}
          <button class="btn btn-sm btn-del" data-act="del">Del</button>
        </div>
      </div>`;
    }).join('');
  },

  _catModal() {
    const m = App.ui.modal({
      title: 'Manage Categories', wide: true,
      bodyHtml: `<div id="catMgrList"></div>
        <div class="row gap" style="margin-top:12px"><input id="catNewName" placeholder="New category name…" class="fill"><button class="btn btn-primary btn-sm" id="catNewAdd">+ Add</button></div>`,
      footerHtml: `<button class="btn btn-primary" data-a="done">Done</button>`,
    });
    const refresh = () => {
      m.el.querySelector('#catMgrList').innerHTML = this.cache.categories.map((c) => {
        const col = App.catColor(c.name);
        return `<div class="cat-row" data-catid="${c.id}">
          <span class="cat-dot" style="background:${col}"></span>
          <span class="cat-nm">${App.ui.esc(c.name)}</span>
          <span class="cat-cnt muted">${c.productCount || 0} products</span>
          <button class="btn btn-sm btn-ghost" data-act="rename">✎</button>
          <button class="btn btn-sm btn-danger" data-act="delcat">✕</button>
        </div>`;
      }).join('');
    };
    refresh();
    m.el.querySelector('[data-a="done"]').onclick = () => { m.close(); this._load().then(() => { this._renderChips(); this._renderGrid(); }); };
    m.el.querySelector('#catNewAdd').onclick = async () => {
      const name = m.el.querySelector('#catNewName').value.trim();
      if (!name) return;
      try { await App.pos.categories.create(name); App.ui.toast('Added ✓', 'ok'); m.el.querySelector('#catNewName').value = ''; await this._load(); refresh(); }
      catch (e) { App.ui.toast(e.message, 'err'); }
    };
    m.el.querySelector('#catMgrList').addEventListener('click', async (e) => {
      const id = +e.target.closest('[data-catid]')?.dataset.catid; if (!id) return;
      if (e.target.dataset.act === 'rename') {
        const cat = this.cache.categories.find((c) => c.id === id);
        if (!cat) return;
        // Use a styled modal instead of the native prompt() which can be
        // blocked or theme-inconsistent in the Electron renderer.
        const rm = App.ui.modal({
          title: 'Rename Category', closeOnOverlay: false,
          bodyHtml: `<div class="field"><label class="fl">Category name</label><input id="catRenameInput" value="${App.ui.esc(cat.name)}" autofocus></div>`,
          footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Rename</button>`,
        });
        rm.el.querySelector('[data-a="cancel"]').onclick = () => rm.close();
        const inp = rm.el.querySelector('#catRenameInput');
        inp.focus(); inp.select();
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') rm.el.querySelector('[data-a="ok"]').click(); });
        rm.el.querySelector('[data-a="ok"]').onclick = async () => {
          const nn = inp.value.trim();
          if (!nn) { App.ui.toast('Name is required', 'err'); return; }
          try { await App.pos.categories.update(id, nn); await this._load(); refresh(); App.ui.toast('Renamed ✓', 'ok'); rm.close(); }
          catch (err) { App.ui.toast(err.message, 'err'); }
        };
      } else if (e.target.dataset.act === 'delcat') {
        const cat = this.cache.categories.find((c) => c.id === id);
        const ok = await App.ui.confirm(`Delete "${cat.name}"? ${cat.productCount || 0} product(s) will lose their category.`, { danger: true });
        if (ok) { try { await App.pos.categories.delete(id); await this._load(); refresh(); App.ui.toast('Deleted', 'ok'); } catch (err) { App.ui.toast(err.message, 'err'); } }
      }
    });
  },

  _edit(id) {
    const p = id ? this.cache.products.find((x) => x.id === id) : null;
    const cats = this.cache.categories;
    const m = App.ui.modal({
      title: id ? 'Edit Product' : 'Add Product', closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Product Name</label><input id="fName" value="${p ? App.ui.esc(p.name) : ''}" autofocus></div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Category</label><select id="fCat">
            <option value="">— No category —</option>
            ${cats.map((c) => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('')}
            <option value="__new">+ Add new category…</option>
          </select></div>
          <div class="field" style="flex:1"><label class="fl">Unit</label><input id="fUnit" value="${p ? App.ui.esc(p.base_unit) : 'pc'}" placeholder="e.g. bag, pc, kg"></div>
        </div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Stock</label><input id="fStock" type="number" step="0.001" value="${p ? p.stock : 0}"${id ? ' data-orig="' + p.stock + '"' : ''}></div>
          <div class="field" style="flex:1"><label class="fl">Price</label><input id="fPrice" type="number" step="0.01" value="${p ? p.price : 0}"></div>
        </div>${id ? '<div class="hint" style="margin-top:-4px">Changing Stock here logs an adjustment movement. Use the <b>Stock</b> button on the card for date/location.</div>' : ''}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="save">Save</button>`,
    });
    // "Add new category" handler
    m.el.querySelector('#fCat').onchange = async (e) => {
      if (e.target.value !== '__new') return;
      // Use a styled modal instead of the native prompt().
      const cm = App.ui.modal({
        title: 'New Category', closeOnOverlay: false,
        bodyHtml: `<div class="field"><label class="fl">Category name</label><input id="newCatInput" autofocus></div>`,
        footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Add</button>`,
      });
      cm.el.querySelector('[data-a="cancel"]').onclick = () => { cm.close(); e.target.value = p && p.category_id ? p.category_id : ''; };
      const catInput = cm.el.querySelector('#newCatInput');
      catInput.focus();
      catInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') cm.el.querySelector('[data-a="ok"]').click(); });
      cm.el.querySelector('[data-a="ok"]').onclick = async () => {
        const name = catInput.value.trim();
        if (!name) { App.ui.toast('Name is required', 'err'); return; }
        try {
          const r = await App.pos.categories.create(name);
          await this._load();
          const sel = m.el.querySelector('#fCat');
          sel.innerHTML = `<option value="">— No category —</option>` +
            this.cache.categories.map((c) => `<option value="${c.id}" ${c.id === r.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('') +
            `<option value="__new">+ Add new category…</option>`;
          App.ui.toast('Category added ✓', 'ok');
          cm.close();
        } catch (err) { App.ui.toast(err.message, 'err'); e.target.value = ''; cm.close(); }
      };
    };
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async () => {
      const num = (s, fallback = 0) => {
        const n = parseFloat(String(s).replace(/,/g, ''));
        return Number.isFinite(n) ? n : fallback;
      };
      const name = m.el.querySelector('#fName').value.trim();
      if (!name) { App.ui.toast('Name is required', 'err'); return; }
      const baseUnit = m.el.querySelector('#fUnit').value.trim() || 'pc';
      const price = num(m.el.querySelector('#fPrice').value);
      const data = {
        sku: id && p ? p.sku : '',
        name,
        category_id: +m.el.querySelector('#fCat').value || null,
        base_unit: baseUnit,
        stock: parseFloat(m.el.querySelector('#fStock').value) || 0,
        cost: id && p ? p.cost : 0,
        price,
        low_stock_threshold: id && p ? (p.low != null ? p.low : 10) : 10,
        is_service: false,
        units: [{ unit: baseUnit, factor: 1, price }],
      };
      try {
        if (id) {
          await App.pos.products.update(id, data);
          // If the cashier edited the stock field, route the change through
          // setStock so a stock_movements audit row is written (the UPDATE
          // statement in pos:products:update intentionally does not touch
          // stock — that's setStock's job). This keeps the audit log intact
          // while letting admins adjust stock directly from the Edit modal.
          const stockEl = m.el.querySelector('#fStock');
          const orig = parseFloat(stockEl.dataset.orig);
          const newStock = parseFloat(stockEl.value) || 0;
          if (Number.isFinite(orig) && Math.abs(newStock - orig) > 1e-9) {
            await App.pos.products.setStock(id, newStock, 'Adjusted via Edit', null, null);
          }
        } else {
          await App.pos.products.create(data);
        }
        App.ui.toast('Saved ✓', 'ok'); m.close();
        await this._load(); this._renderChips(); this._renderGrid();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _editService(id) {
    const p = id ? this.cache.products.find((x) => x.id === id) : null;
    const cats = this.cache.categories;
    const m = App.ui.modal({
      title: id ? 'Edit Service' : 'Add Service', closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Service Name</label><input id="fName" value="${p ? App.ui.esc(p.name) : ''}" autofocus placeholder="e.g. Delivery, Labor, Installation"></div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Price</label><input id="fPrice" type="number" step="0.01" value="${p ? p.price : 0}"></div>
          <div class="field" style="flex:1"><label class="fl">Category (optional)</label><select id="fCat">
            <option value="">— No category —</option>
            ${cats.map((c) => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('')}
            <option value="__new">+ Add new category…</option>
          </select></div>
        </div>
        <div class="hint">Services have no stock tracking. Price is per unit of service.</div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="save">Save</button>`,
    });
    m.el.querySelector('#fCat').onchange = async (e) => {
      if (e.target.value !== '__new') return;
      const cm = App.ui.modal({
        title: 'New Category', closeOnOverlay: false,
        bodyHtml: `<div class="field"><label class="fl">Category name</label><input id="newCatInput" autofocus></div>`,
        footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Add</button>`,
      });
      cm.el.querySelector('[data-a="cancel"]').onclick = () => { cm.close(); e.target.value = p && p.category_id ? p.category_id : ''; };
      const catInput = cm.el.querySelector('#newCatInput');
      catInput.focus();
      catInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') cm.el.querySelector('[data-a="ok"]').click(); });
      cm.el.querySelector('[data-a="ok"]').onclick = async () => {
        const name = catInput.value.trim();
        if (!name) { App.ui.toast('Name is required', 'err'); return; }
        try {
          const r = await App.pos.categories.create(name);
          await this._load();
          const sel = m.el.querySelector('#fCat');
          sel.innerHTML = `<option value="">— No category —</option>` +
            this.cache.categories.map((c) => `<option value="${c.id}" ${c.id === r.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('') +
            `<option value="__new">+ Add new category…</option>`;
          App.ui.toast('Category added ✓', 'ok');
          cm.close();
        } catch (err) { App.ui.toast(err.message, 'err'); e.target.value = ''; cm.close(); }
      };
    };
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async () => {
      const num = (s, fallback = 0) => {
        const n = parseFloat(String(s).replace(/,/g, ''));
        return Number.isFinite(n) ? n : fallback;
      };
      const name = m.el.querySelector('#fName').value.trim();
      if (!name) { App.ui.toast('Service name is required', 'err'); return; }
      const price = num(m.el.querySelector('#fPrice').value);
      if (price <= 0) { App.ui.toast('Price must be greater than zero', 'err'); return; }
      const data = {
        sku: id && p ? p.sku : '',
        name,
        category_id: +m.el.querySelector('#fCat').value || null,
        base_unit: 'svc',
        stock: 0,
        cost: id && p ? p.cost : 0,
        price,
        low_stock_threshold: 0,
        is_service: true,
        units: [{ unit: 'svc', factor: 1, price }],
      };
      try {
        if (id) await App.pos.products.update(id, data);
        else await App.pos.products.create(data);
        App.ui.toast('Service saved ✓', 'ok'); m.close();
        await this._load(); this._renderChips(); this._renderGrid();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _stock(id) {
    const p = this.cache.products.find((x) => x.id === id);
    const today = new Date().toISOString().slice(0, 10);
    const m = App.ui.modal({
      title: 'Adjust Stock — ' + p.name, closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Current stock (${App.ui.esc(p.base_unit)})</label><input value="${App.ui.qty(p.stock)}" readonly></div>
        <div class="field"><label class="fl">New stock count (${App.ui.esc(p.base_unit)})</label><input id="sNew" type="number" step="0.001" value="${p.stock}" autofocus></div>
        <div class="field"><label class="fl">Reason</label><input id="sReason" placeholder="Stock count / delivery / loss"></div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Restock Date</label><input id="sDate" type="date" value="${today}"></div>
          <div class="field" style="flex:1"><label class="fl">Purchase Location</label><input id="sLocation" value="Cogon commercial" placeholder="Where was this purchased?"></div>
        </div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Save</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = async () => {
      try {
        await App.pos.products.setStock(
          id,
          parseFloat(m.el.querySelector('#sNew').value) || 0,
          m.el.querySelector('#sReason').value,
          m.el.querySelector('#sDate').value,
          m.el.querySelector('#sLocation').value
        );
        App.ui.toast('Stock updated ✓', 'ok'); m.close(); await this._load(); this._renderChips(); this._renderGrid();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _del(id) {
    const p = this.cache.products.find((x) => x.id === id);
    App.ui.confirm(`Deactivate "${p.name}"? It stays in history but can no longer be sold.`, { danger: true }).then(async (ok) => {
      if (!ok) return;
      try { await App.pos.products.delete(id); App.ui.toast('Deactivated', 'ok'); await this._load(); this._renderChips(); this._renderGrid(); }
      catch (e) { App.ui.toast(e.message, 'err'); }
    });
  },

  async _deleteAll() {
    const count = this.cache.products.length;
    if (!count) { App.ui.toast('No products to delete', 'err'); return; }
    const ok = await App.ui.confirm(
      `This will DELETE ALL ${count} products, their sellable units, and stock movements.\n\nCategory names are PRESERVED. Historical sales keep their references (products are soft-deleted).\n\nThis cannot be undone. Consider exporting a backup first.\n\nContinue?`,
      { danger: true, title: 'Delete all products' }
    );
    if (!ok) return;
    const ok2 = await App.ui.confirm('Final confirmation: erase ALL products?', { danger: true, title: 'Are you sure?' });
    if (!ok2) return;
    try {
      const r = await App.pos.products.deleteAll();
      App.ui.toast(`Deleted ${r.products} product(s) ✓`, 'ok');
      await this._load(); this._renderChips(); this._renderGrid();
    } catch (e) { App.ui.toast(e.message, 'err'); }
  },

  async _importCatalog() {
    const ok = await App.ui.confirm(
      'Import the saved product catalog (245 construction-supply items across 11 categories)?\n\nEach item is created with ₱0 price and 0 stock — you will edit those afterward. Categories are created automatically. Duplicate names are skipped.',
      { title: 'Import product catalog' }
    );
    if (!ok) return;
    try {
      const res = await fetch('assets/product-catalog.json');
      const items = await res.json();
      const r = await App.pos.products.bulkImport(items);
      App.ui.toast(`Imported ${r.imported} product(s) ✓ (${r.skipped} skipped)`, 'ok');
      await this._load(); this._renderChips(); this._renderGrid();
    } catch (e) { App.ui.toast(e.message, 'err'); }
  },
};
