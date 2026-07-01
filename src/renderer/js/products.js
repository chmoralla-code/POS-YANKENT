'use strict';
/* Admin: product catalog & inventory management. */
window.App = window.App || {};
App.views = App.views || {};

App.views.products = {
  title: 'Products & Inventory',
  cache: { products: [], categories: [] },
  q: '',
  cat: 'all',

  async render(view) {
    this.viewEl = view;
    await this._load();
    view.innerHTML = `
      <div class="toolbar">
        <input id="pSearch" placeholder="Search name…" class="fill" style="max-width:300px">
        <button class="btn btn-ghost btn-sm" id="pClear">Clear</button>
        <div class="fill"></div>
        <button class="btn btn-ghost btn-sm" id="catManage">Manage Categories</button>
        <button class="btn btn-primary btn-sm" id="pAdd">+ Add Product</button>
      </div>
      <div class="chips" id="pChips"></div>
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
    v.querySelector('#pClear').onclick = async () => { this.q = ''; v.querySelector('#pSearch').value = ''; await this._load(); this._renderChips(); this._renderGrid(); };
    v.querySelector('#pAdd').onclick = () => this._edit(null);
    v.querySelector('#catManage').onclick = () => this._catModal();
    v.querySelector('#pChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]'); if (!chip) return;
      this.cat = chip.dataset.cat; this._renderChips(); this._renderGrid();
    });
    v.querySelector('#pGrid').addEventListener('click', (e) => {
      const id = +e.target.closest('[data-id]')?.dataset.id; if (!id) return;
      if (e.target.dataset.act === 'edit') this._edit(id);
      else if (e.target.dataset.act === 'stock') this._stock(id);
      else if (e.target.dataset.act === 'del') this._del(id);
    });
  },

  _renderChips() {
    const el = this.viewEl.querySelector('#pChips');
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
          <button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>
          ${p.is_service ? '' : '<button class="btn btn-sm btn-ghost" data-act="stock">Stock</button>'}
          <button class="btn btn-sm btn-danger" data-act="del">Del</button>
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
        const nn = prompt('Rename category:', cat ? cat.name : '');
        if (nn && nn.trim()) { try { await App.pos.categories.update(id, nn.trim()); await this._load(); refresh(); App.ui.toast('Renamed ✓', 'ok'); } catch (err) { App.ui.toast(err.message, 'err'); } }
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
    const units = (p && p.units) || [{ unit: p ? p.base_unit : 'pc', factor: 1, price: p ? p.price : 0 }];
    const m = App.ui.modal({
      title: id ? 'Edit Product' : 'Add Product', wide: true,
      bodyHtml: `<div class="field"><label class="fl">Name</label><input id="fName" value="${p ? App.ui.esc(p.name) : ''}"></div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Category</label><select id="fCat">
            <option value="">— No category —</option>
            ${cats.map((c) => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('')}
            <option value="__new">+ Add new category…</option>
          </select></div>
          <div class="field" style="flex:1"><label class="fl">Base unit (stock unit)</label><input id="fBase" value="${p ? App.ui.esc(p.base_unit) : 'pc'}"></div>
        </div>
        <div class="row gap wrap">
          <div class="field" style="flex:1"><label class="fl">Stock (in base unit)</label><input id="fStock" type="number" step="0.001" value="${p ? p.stock : 0}" ${id ? 'readonly' : ''}></div>
          <div class="field" style="flex:1"><label class="fl">Cost</label><input id="fCost" type="number" step="0.01" value="${p ? p.cost : 0}"></div>
          <div class="field" style="flex:1"><label class="fl">Default price</label><input id="fPrice" type="number" step="0.01" value="${p ? p.price : 0}"></div>
          <div class="field" style="flex:1"><label class="fl">Low-stock threshold</label><input id="fLow" type="number" step="0.001" value="${p ? p.low : 10}"></div>
        </div>
        <label class="row gap-sm"><input type="checkbox" id="fSvc" ${p && p.is_service ? 'checked' : ''}> This is a service (no stock)</label>
        <div class="sec-title" style="margin-top:12px">Sellable units &amp; conversion factors</div>
        <div class="hint">Factor = base units consumed per 1 of this unit (e.g. cement: bag=1, sack(50kg)=1.25).</div>
        <div id="fUnits"></div>
        <button class="btn btn-sm btn-ghost" id="fAddUnit">+ Add unit</button>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="save">Save</button>`,
    });
    const uList = m.el.querySelector('#fUnits');
    const renderUnits = () => {
      uList.innerHTML = units.map((u, i) => `<div class="row gap-sm" style="margin-bottom:6px">
        <input class="fill" data-u="unit" placeholder="unit" value="${App.ui.esc(u.unit)}" style="max-width:160px">
        <input data-u="factor" type="number" step="0.0001" placeholder="factor" value="${u.factor}" style="max-width:100px">
        <input data-u="price" type="number" step="0.01" placeholder="price" value="${u.price}" style="max-width:120px">
        <button class="btn btn-sm btn-danger" data-u="del">✕</button></div>`).join('');
      uList.querySelectorAll('div').forEach((d, i) => {
        d.querySelectorAll('input').forEach((inp) => inp.oninput = () => { units[i][inp.dataset.u] = inp.value; });
        d.querySelector('[data-u="del"]').onclick = () => { units.splice(i, 1); renderUnits(); };
      });
    };
    renderUnits();
    m.el.querySelector('#fAddUnit').onclick = () => { units.push({ unit: '', factor: 1, price: 0 }); renderUnits(); };
    // "Add new category" handler
    m.el.querySelector('#fCat').onchange = async (e) => {
      if (e.target.value !== '__new') return;
      const name = prompt('New category name:');
      if (!name) { e.target.value = p && p.category_id ? p.category_id : ''; return; }
      try {
        const r = await App.pos.categories.create(name.trim());
        await this._load();
        const sel = m.el.querySelector('#fCat');
        sel.innerHTML = `<option value="">— No category —</option>` +
          this.cache.categories.map((c) => `<option value="${c.id}" ${c.id === r.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('') +
          `<option value="__new">+ Add new category…</option>`;
        App.ui.toast('Category added ✓', 'ok');
      } catch (err) { App.ui.toast(err.message, 'err'); e.target.value = ''; }
    };
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async () => {
      const data = {
        sku: id && p ? p.sku : '',
        name: m.el.querySelector('#fName').value.trim(),
        category_id: +m.el.querySelector('#fCat').value || null,
        base_unit: m.el.querySelector('#fBase').value.trim() || 'pc',
        stock: parseFloat(m.el.querySelector('#fStock').value) || 0,
        cost: parseFloat(m.el.querySelector('#fCost').value) || 0,
        price: parseFloat(m.el.querySelector('#fPrice').value) || 0,
        low_stock_threshold: parseFloat(m.el.querySelector('#fLow').value) || 0,
        is_service: m.el.querySelector('#fSvc').checked,
        units: units.filter((u) => u.unit).map((u) => ({ unit: u.unit, factor: +u.factor || 1, price: +u.price || 0 })),
      };
      if (!data.name) { App.ui.toast('Name is required', 'err'); return; }
      try {
        if (id) await App.pos.products.update(id, data);
        else await App.pos.products.create(data);
        App.ui.toast('Saved ✓', 'ok'); m.close();
        await this._load(); this._render();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _stock(id) {
    const p = this.cache.products.find((x) => x.id === id);
    const m = App.ui.modal({
      title: 'Adjust Stock — ' + p.name,
      bodyHtml: `<div class="field"><label class="fl">Current stock (${App.ui.esc(p.base_unit)})</label><input value="${App.ui.qty(p.stock)}" readonly></div>
        <div class="field"><label class="fl">New stock count (${App.ui.esc(p.base_unit)})</label><input id="sNew" type="number" step="0.001" value="${p.stock}" autofocus></div>
        <div class="field"><label class="fl">Reason</label><input id="sReason" placeholder="Stock count / delivery / loss"></div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Save</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = async () => {
      try {
        await App.pos.products.setStock(id, parseFloat(m.el.querySelector('#sNew').value) || 0, m.el.querySelector('#sReason').value);
        App.ui.toast('Stock updated ✓', 'ok'); m.close(); await this._load(); this._render();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _del(id) {
    const p = this.cache.products.find((x) => x.id === id);
    App.ui.confirm(`Deactivate "${p.name}"? It stays in history but can no longer be sold.`, { danger: true }).then(async (ok) => {
      if (!ok) return;
      try { await App.pos.products.delete(id); App.ui.toast('Deactivated', 'ok'); await this._load(); this._render(); }
      catch (e) { App.ui.toast(e.message, 'err'); }
    });
  },
};
