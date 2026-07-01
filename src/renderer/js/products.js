'use strict';
/* Admin: product catalog & inventory management. */
window.App = window.App || {};
App.views = App.views || {};

App.views.products = {
  title: 'Products & Inventory',
  cache: { products: [], categories: [] },
  q: '',

  async render(view) {
    this.viewEl = view;
    await this._load();
    view.innerHTML = `
      <div class="toolbar">
        <input id="pSearch" placeholder="Search SKU / name…" class="fill" style="max-width:340px">
        <button class="btn btn-ghost btn-sm" id="pClear">Clear</button>
        <div class="fill"></div>
        <button class="btn btn-primary btn-sm" id="pAdd">+ Add Product</button>
      </div>
      <div class="panel">
        <div class="panel-h">Catalog <small id="pCount"></small></div>
        <div style="overflow:auto;max-height:calc(100vh - 200px)">
          <table class="tbl">
            <thead><tr><th>Name</th><th>Category</th><th>Base unit</th><th>Stock</th><th>Price</th><th>Units</th><th>Service</th><th></th></tr></thead>
            <tbody id="pBody"></tbody>
          </table>
        </div>
      </div>`;
    this._wire();
    this._render();
  },

  async _load() {
    const [products, categories] = await Promise.all([
      App.pos.products.list({ includeServices: true, q: this.q || undefined }),
      App.pos.categories.list(),
    ]);
    this.cache = { products, categories };
  },

  _wire() {
    const v = this.viewEl;
    const d = App.ui.debounce(async () => { await this._load(); this._render(); }, 250);
    v.querySelector('#pSearch').addEventListener('input', (e) => { this.q = e.target.value; d(); });
    v.querySelector('#pClear').onclick = async () => { this.q = ''; v.querySelector('#pSearch').value = ''; await this._load(); this._render(); };
    v.querySelector('#pAdd').onclick = () => this._edit(null);
    v.querySelector('#pBody').addEventListener('click', (e) => {
      const id = +e.target.closest('[data-id]')?.dataset.id; if (!id) return;
      if (e.target.dataset.act === 'edit') this._edit(id);
      else if (e.target.dataset.act === 'stock') this._stock(id);
      else if (e.target.dataset.act === 'del') this._del(id);
    });
  },

  _render() {
    const body = this.viewEl.querySelector('#pBody');
    this.viewEl.querySelector('#pCount').textContent = this.cache.products.length + ' items';
    body.innerHTML = this.cache.products.map((p) => `
      <tr data-id="${p.id}">
        <td>${App.ui.esc(p.name)}</td>
        <td><span class="cat-badge" style="background:${App.catColor(p.category)}">${App.ui.esc(p.category || '—')}</span></td>
        <td>${App.ui.esc(p.base_unit)}</td>
        <td class="${p.stock <= (p.low || 10) && !p.is_service ? 'muted' : ''}">${p.is_service ? '—' : App.ui.qty(p.stock)}</td>
        <td>${App.ui.money(p.price)}</td>
        <td class="muted">${(p.units || []).map((u) => App.ui.esc(u.unit)).join(', ') || '—'}</td>
        <td>${p.is_service ? '<span class="badge svc">yes</span>' : ''}</td>
        <td class="right">
          <button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>
          ${p.is_service ? '' : '<button class="btn btn-sm btn-ghost" data-act="stock">Stock</button>'}
          <button class="btn btn-sm btn-danger" data-act="del">Del</button>
        </td>
      </tr>`).join('');
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
            ${cats.map((c) => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${App.ui.esc(c.name)}</option>`).join('')}
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
