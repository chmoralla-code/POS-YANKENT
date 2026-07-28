'use strict';
/* Admin: authoritative margin report for active, in-stock products in the
 * "Newly Added Items" category. Calculations and exports stay in main;
 * this view manages readiness and presents the returned report. */
window.App = window.App || {};
App.views = App.views || {};

App.views.margins = {
  title: 'Generate Margin Table',
  viewEl: null,
  readiness: null,
  report: null,
  selected: new Set(),
  prepShown: 100,
  reportShown: 100,
  batchSize: 100,
  search: '',
  sourceFilter: 'all',
  _sessionGeneration: null,
  _outsideClick: null,

  async render(view) {
    const generation = App.captureSessionGeneration();
    this._sessionGeneration = generation;
    this.viewEl = view;
    this.readiness = null;
    this.report = null;
    this.selected = new Set();
    this.prepShown = this.batchSize;
    this.reportShown = this.batchSize;
    this.search = '';
    this.sourceFilter = 'all';

    view.classList.add('view-margins');
    view.innerHTML = `
      <div class="margin-page">
        <header class="margin-header">
          <div class="margin-heading">
            <div class="margin-eyebrow">Inventory costing · Newly Added Items</div>
            <h2>Generate Margin Table</h2>
            <p>Prepare purchase sources, then calculate the original cost and potential gross profit of active items currently in stock.</p>
          </div>
          <div class="margin-header-actions">
            <button type="button" class="btn btn-sm btn-ghost" id="mRefresh">
              <span aria-hidden="true">↻</span> Refresh
            </button>
            <div class="margin-download" id="mDownload">
              <button type="button" class="btn btn-sm btn-ghost margin-download-trigger" id="mDownloadBtn"
                aria-haspopup="menu" aria-expanded="false" aria-controls="mDownloadMenu" disabled>
                <span aria-hidden="true">↓</span> Download <span class="margin-caret" aria-hidden="true">▾</span>
              </button>
              <div class="margin-download-menu" id="mDownloadMenu" role="menu" hidden>
                <button type="button" role="menuitem" data-format="excel">
                  <span class="margin-file-mark" aria-hidden="true">XLSX</span>
                  <span><strong>Excel workbook</strong><small>Editable spreadsheet</small></span>
                </button>
                <button type="button" role="menuitem" data-format="pdf">
                  <span class="margin-file-mark" aria-hidden="true">PDF</span>
                  <span><strong>PDF document</strong><small>Print-ready report</small></span>
                </button>
              </div>
            </div>
          </div>
        </header>

        <div class="margin-scope-note">
          <span class="margin-scope-mark" aria-hidden="true">N</span>
          <div>
            <strong>Report scope</strong>
            <span>Active, in-stock products from the <b>Newly Added Items</b> category only. Services and zero-stock items are excluded.</span>
          </div>
        </div>

        <section id="mReadiness" aria-live="polite" aria-busy="true">
          <div class="margin-loading">
            <span class="spinner" aria-hidden="true"></span>
            <div><strong>Checking table readiness</strong><span>Reviewing item prices and purchase sources…</span></div>
          </div>
        </section>

        <section id="mReport" class="margin-report" aria-live="polite" hidden></section>
        <p class="margin-sr-only" id="mLive" aria-live="polite"></p>
      </div>`;

    view.querySelector('#mRefresh').addEventListener('click', () => this._loadReadiness());
    view.querySelector('#mDownloadBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggleDownloadMenu();
    });
    view.querySelectorAll('#mDownloadMenu [data-format]').forEach((button) => {
      button.addEventListener('click', () => this._export(button.dataset.format));
    });
    view.querySelector('#mDownloadMenu').addEventListener('keydown', (event) => this._onDownloadKeydown(event));
    this._outsideClick = (event) => {
      const download = this.viewEl && this.viewEl.querySelector('#mDownload');
      if (download && !download.contains(event.target)) this._closeDownloadMenu();
    };
    document.addEventListener('click', this._outsideClick);
    await this._loadReadiness();
  },

  destroy() {
    if (this._outsideClick) document.removeEventListener('click', this._outsideClick);
    this._outsideClick = null;
    if (this.viewEl) {
      this.viewEl.classList.remove('view-margins');
      this.viewEl.innerHTML = '';
    }
    this.viewEl = null;
    this.readiness = null;
    this.report = null;
    this.selected = new Set();
  },

  _isCurrent(generation = this._sessionGeneration) {
    return !!this.viewEl
      && generation === this._sessionGeneration
      && App.isSessionGenerationCurrent(generation)
      && App.current.view === 'margins';
  },

  _number(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  },

  _count(data, camel, snake) {
    const value = data && (data[camel] != null ? data[camel] : data[snake]);
    return Math.max(0, this._number(value));
  },

  _rows(data) {
    return data && Array.isArray(data.rows) ? data.rows : [];
  },

  _source(row) {
    return String((row && (row.purchase_source != null ? row.purchase_source : row.purchaseSource)) || '').trim();
  },

  _sourceMissing(row) {
    if (row && typeof row.source_missing === 'boolean') return row.source_missing;
    if (row && typeof row.sourceMissing === 'boolean') return row.sourceMissing;
    return !this._source(row);
  },

  _priceValid(row) {
    if (row && typeof row.price_valid === 'boolean') return row.price_valid;
    if (row && typeof row.priceValid === 'boolean') return row.priceValid;
    const price = this._number(row && (row.selling_price != null ? row.selling_price : row.sellingPrice));
    const profit = this._number(row && (row.unit_profit != null ? row.unit_profit : row.unitProfit));
    return price > 0 && price > profit;
  },

  _field(row, snake, camel, fallback = '') {
    if (!row) return fallback;
    if (row[snake] != null) return row[snake];
    if (row[camel] != null) return row[camel];
    return fallback;
  },

  _itemName(row) {
    return String(this._field(row, 'name', 'name', 'Unnamed item'));
  },

  _announce(message) {
    const live = this.viewEl && this.viewEl.querySelector('#mLive');
    if (live) live.textContent = message;
  },

  _setReport(report) {
    this.report = report || null;
    const button = this.viewEl && this.viewEl.querySelector('#mDownloadBtn');
    if (button) button.disabled = !this.report;
    if (!this.report) this._closeDownloadMenu();
  },

  async _loadReadiness() {
    if (!this.viewEl) return;
    const generation = this._sessionGeneration;
    const region = this.viewEl.querySelector('#mReadiness');
    const refresh = this.viewEl.querySelector('#mRefresh');
    this._setReport(null);
    const reportRegion = this.viewEl.querySelector('#mReport');
    if (reportRegion) {
      reportRegion.hidden = true;
      reportRegion.innerHTML = '';
    }
    this.selected = new Set();
    this.prepShown = this.batchSize;
    if (refresh) {
      refresh.disabled = true;
      refresh.setAttribute('aria-busy', 'true');
      refresh.innerHTML = '<span class="spinner margin-spinner-sm" aria-hidden="true"></span> Refreshing';
    }
    if (region) {
      region.setAttribute('aria-busy', 'true');
      region.innerHTML = `
        <div class="margin-loading">
          <span class="spinner" aria-hidden="true"></span>
          <div><strong>Checking table readiness</strong><span>Reviewing item prices and purchase sources…</span></div>
        </div>`;
    }

    try {
      const data = await App.pos.margins.readiness();
      if (!this._isCurrent(generation)) return;
      this.readiness = data || {};
      this._renderReadiness();
      this._announce('Product margin readiness check complete.');
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      const message = error && error.message ? error.message : 'Unable to check product margin readiness.';
      region.innerHTML = `
        <div class="margin-error" role="alert">
          <span class="margin-error-mark" aria-hidden="true">!</span>
          <div><strong>Readiness check failed</strong><p>${App.ui.esc(message)}</p></div>
          <button type="button" class="btn btn-sm btn-ghost" id="mRetry">Try again</button>
        </div>`;
      region.querySelector('#mRetry').addEventListener('click', () => this._loadReadiness());
    } finally {
      if (!this._isCurrent(generation)) return;
      region.setAttribute('aria-busy', 'false');
      if (refresh) {
        refresh.disabled = false;
        refresh.removeAttribute('aria-busy');
        refresh.innerHTML = '<span aria-hidden="true">↻</span> Refresh';
      }
    }
  },

  _renderReadiness() {
    const data = this.readiness || {};
    const rows = this._rows(data);
    const eligible = this._count(data, 'eligibleCount', 'eligible_count') || rows.length;
    const missing = this._count(data, 'missingSourceCount', 'missing_source_count')
      || rows.filter((row) => this._sourceMissing(row)).length;
    const invalid = this._count(data, 'invalidPriceCount', 'invalid_price_count')
      || rows.filter((row) => !this._priceValid(row)).length;
    const completedValue = data.completedCount != null ? data.completedCount : data.completed_count;
    const completed = completedValue == null
      ? Math.max(0, eligible - new Set(rows.filter((row) => this._sourceMissing(row) || !this._priceValid(row)).map((row) => row.id)).size)
      : this._number(completedValue);
    const canGenerate = typeof data.canGenerate === 'boolean'
      ? data.canGenerate
      : (typeof data.can_generate === 'boolean' ? data.can_generate : eligible > 0 && missing === 0 && invalid === 0);
    const percent = eligible ? Math.min(100, Math.round((completed / eligible) * 100)) : 0;
    // Keep saved sources editable so a typo, supplier change, or stale value
    // can be corrected. Rows needing attention stay first in a large catalog.
    const prepRows = [...rows].sort((a, b) => {
      const aNeedsAttention = this._sourceMissing(a) || !this._priceValid(a);
      const bNeedsAttention = this._sourceMissing(b) || !this._priceValid(b);
      if (aNeedsAttention !== bNeedsAttention) return aNeedsAttention ? -1 : 1;
      return this._itemName(a).localeCompare(this._itemName(b));
    });
    const visibleRows = prepRows.slice(0, this.prepShown);
    const region = this.viewEl.querySelector('#mReadiness');

    region.innerHTML = `
      <div class="margin-readiness-top">
        <div class="margin-progress-copy">
          <div class="margin-progress-title">
            <span>Preparation progress</span>
            <strong>${App.ui.esc(String(completed))} / ${App.ui.esc(String(eligible))} rows ready</strong>
          </div>
          <div class="margin-progress-track" role="progressbar" aria-label="Table preparation progress"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
            <span style="width:${percent}%"></span>
          </div>
        </div>
        <button type="button" class="btn btn-primary margin-generate" id="mGenerate"
          ${canGenerate ? '' : 'disabled'} aria-describedby="mGenerateHint">
          Generate Margin Table
        </button>
      </div>
      <p class="margin-generate-hint" id="mGenerateHint">
        ${eligible === 0
          ? 'No eligible products are currently available in this category.'
          : (canGenerate
            ? 'All required details are complete. Generate the live calculation when ready.'
            : 'Complete every purchase source and fix invalid selling prices before generating.')}
      </p>

      <div class="margin-readiness-grid" aria-label="Readiness summary">
        ${this._metric('Eligible items', eligible, 'Active products with stock')}
        ${this._metric('Ready rows', completed, percent + '% complete', completed === eligible && eligible > 0 ? 'is-ready' : '')}
        ${this._metric('Missing source', missing, missing ? 'Requires purchase location' : 'All sources complete', missing ? 'needs-attention' : '')}
        ${this._metric('Price fixes', invalid, invalid ? 'Update in Products & Inventory' : 'All prices usable', invalid ? 'needs-attention' : '')}
      </div>

      <div class="margin-rules" aria-label="Automatic margin rules">
        <span class="margin-rules-title">Automatic unit profit</span>
        <span><b>≤ ${App.ui.money(100)}</b> selling price <strong>+${App.ui.money(10)}</strong></span>
        <span><b>${App.ui.money(100.01)}–${App.ui.money(200)}</b> <strong>+${App.ui.money(15)}</strong></span>
        <span><b>&gt; ${App.ui.money(200)}</b> <strong>+${App.ui.money(20)}</strong></span>
      </div>

      ${eligible === 0 ? this._emptyReadiness() : ''}
      ${eligible > 0 ? this._renderActionPanel(visibleRows, prepRows.length, invalid) : ''}
      ${eligible > 0 && missing === 0 && invalid === 0 ? `
        <div class="margin-ready-banner">
          <span class="margin-ready-mark" aria-hidden="true">✓</span>
          <div><strong>Everything is ready</strong><p>Every included item has a purchase source and a valid selling price.</p></div>
        </div>` : ''}`;

    const generate = region.querySelector('#mGenerate');
    if (generate) generate.addEventListener('click', () => this._generate());
    const openProducts = region.querySelector('#mOpenProducts');
    if (openProducts) openProducts.addEventListener('click', () => App._navigate('products'));
    this._wireActionPanel(prepRows);
  },

  _metric(label, value, note, modifier = '') {
    return `
      <div class="margin-readiness-card ${modifier}">
        <div class="margin-readiness-label">${App.ui.esc(label)}</div>
        <div class="margin-readiness-value">${App.ui.esc(String(value))}</div>
        <div class="margin-readiness-note">${App.ui.esc(note)}</div>
      </div>`;
  },

  _emptyReadiness() {
    return `
      <div class="margin-empty">
        <span class="margin-empty-mark" aria-hidden="true">0</span>
        <div>
          <strong>No items to calculate</strong>
          <p>Add stock to active products under <b>Newly Added Items</b>, then refresh this page.</p>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" id="mOpenProducts">Open Products &amp; Inventory</button>
      </div>`;
  },

  _renderActionPanel(visibleRows, totalRows, invalidCount) {
    const allVisibleSourceIds = visibleRows.map((row) => Number(row.id));
    const allSelected = allVisibleSourceIds.length > 0 && allVisibleSourceIds.every((id) => this.selected.has(id));
    const sourceSuggestions = [...new Set(this._rows(this.readiness).map((row) => this._source(row)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    return `
      <section class="margin-action-panel" aria-labelledby="mActionTitle">
        <div class="margin-action-head">
          <div>
            <span class="margin-section-index" aria-hidden="true">01</span>
            <div>
              <h3 id="mActionTitle">Complete and review purchase sources</h3>
              <p>${App.ui.esc(String(totalRows))} included item${totalRows === 1 ? '' : 's'}. Blank sources are required; saved sources can be corrected here.</p>
            </div>
          </div>
          ${invalidCount ? `
            <button type="button" class="btn btn-sm btn-ghost" id="mOpenProducts">
              Fix prices in Products &amp; Inventory →
            </button>` : ''}
        </div>

        <div class="margin-bulk-bar">
          <div class="margin-selection-count"><b id="mSelectedCount">${this.selected.size}</b> selected</div>
          <div class="margin-bulk-field">
            <label class="margin-sr-only" for="mBulkSource">Purchase source for selected items</label>
            <input id="mBulkSource" type="text" maxlength="200" list="mSourceSuggestions"
              placeholder="Purchase source for selected items" autocomplete="off">
            <button type="button" class="btn btn-sm btn-primary" id="mBulkApply" ${this.selected.size ? '' : 'disabled'}>
              Apply to selected
            </button>
          </div>
          <datalist id="mSourceSuggestions">
            ${sourceSuggestions.map((source) => `<option value="${App.ui.esc(source)}"></option>`).join('')}
          </datalist>
        </div>

        <div class="margin-prep-table-wrap">
          <table class="margin-table margin-prep-table">
            <thead>
              <tr>
                <th class="margin-check-cell">
                  <input type="checkbox" id="mSelectVisible" aria-label="Select all visible items"
                    ${allSelected ? 'checked' : ''} ${allVisibleSourceIds.length ? '' : 'disabled'}>
                </th>
                <th>Item</th>
                <th class="right">Stock</th>
                <th class="right">Selling Price</th>
                <th>Purchase Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${visibleRows.map((row) => this._renderPrepRow(row)).join('')}
            </tbody>
          </table>
        </div>
        ${totalRows > visibleRows.length ? `
          <div class="margin-load-row">
            <span>Showing ${visibleRows.length} of ${totalRows} included items</span>
            <button type="button" class="btn btn-sm btn-ghost" id="mPrepMore">Load 100 more</button>
          </div>` : ''}
      </section>`;
  },

  _renderPrepRow(row) {
    const id = Number(row.id);
    const sourceMissing = this._sourceMissing(row);
    const priceValid = this._priceValid(row);
    const sku = String(this._field(row, 'sku', 'sku', '')).trim();
    const unit = String(this._field(row, 'unit', 'unit', '')).trim();
    const stock = this._number(this._field(row, 'stock', 'stock', 0));
    const sellingPrice = this._number(this._field(row, 'selling_price', 'sellingPrice', 0));
    const priceError = String(this._field(row, 'price_error', 'priceError', 'Selling price must be higher than the assigned margin.'));

    return `
      <tr data-product-id="${id}" class="${!priceValid ? 'has-price-error' : ''}">
        <td class="margin-check-cell">
          <input type="checkbox" class="m-row-check" value="${id}" aria-label="Select ${App.ui.esc(this._itemName(row))}"
            ${this.selected.has(id) ? 'checked' : ''}>
        </td>
        <td>
          <strong class="margin-item-name">${App.ui.esc(this._itemName(row))}</strong>
          <span class="margin-item-meta">${App.ui.esc([sku, unit].filter(Boolean).join(' · ') || 'Base unit')}</span>
        </td>
        <td class="right margin-number">${App.ui.esc(App.ui.qty(stock))}</td>
        <td class="right margin-number ${priceValid ? '' : 'margin-price-invalid'}">${App.ui.money(sellingPrice)}</td>
        <td>
          <div class="margin-source-editor">
            <label class="margin-sr-only" for="mSource-${id}">Purchase source for ${App.ui.esc(this._itemName(row))}</label>
            <input id="mSource-${id}" class="m-source-input" type="text" maxlength="200"
              list="mSourceSuggestions" placeholder="e.g. Wilcon Depot"
              value="${App.ui.esc(this._source(row))}" autocomplete="off">
            <button type="button" class="btn btn-sm btn-ghost m-source-save" data-id="${id}">${sourceMissing ? 'Save' : 'Update'}</button>
          </div>
        </td>
        <td>
          <div class="margin-row-status">
            ${sourceMissing ? '<span class="margin-status-tag is-missing">Source required</span>' : '<span class="margin-status-tag is-ready">Source ready</span>'}
            ${priceValid ? '' : `<span class="margin-status-tag is-invalid" title="${App.ui.esc(priceError)}">Invalid price</span>`}
          </div>
        </td>
      </tr>`;
  },

  _wireActionPanel(actionRows) {
    const region = this.viewEl.querySelector('#mReadiness');
    const selectVisible = region.querySelector('#mSelectVisible');
    if (selectVisible) {
      selectVisible.addEventListener('change', () => {
        region.querySelectorAll('.m-row-check').forEach((checkbox) => {
          const id = Number(checkbox.value);
          checkbox.checked = selectVisible.checked;
          if (selectVisible.checked) this.selected.add(id);
          else this.selected.delete(id);
        });
        this._syncSelectionControls();
      });
    }
    region.querySelectorAll('.m-row-check').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const id = Number(checkbox.value);
        if (checkbox.checked) this.selected.add(id);
        else this.selected.delete(id);
        this._syncSelectionControls();
      });
    });
    region.querySelectorAll('.m-source-save').forEach((button) => {
      button.addEventListener('click', () => this._saveSource(Number(button.dataset.id), button));
      const input = region.querySelector('#mSource-' + button.dataset.id);
      if (input) {
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this._saveSource(Number(button.dataset.id), button);
          }
        });
      }
    });
    const bulkApply = region.querySelector('#mBulkApply');
    if (bulkApply) bulkApply.addEventListener('click', () => this._bulkSave(bulkApply));
    const bulkInput = region.querySelector('#mBulkSource');
    if (bulkInput) {
      bulkInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && this.selected.size) {
          event.preventDefault();
          this._bulkSave(bulkApply);
        }
      });
    }
    const more = region.querySelector('#mPrepMore');
    if (more) {
      more.addEventListener('click', () => {
        this.prepShown += this.batchSize;
        this._renderReadiness();
      });
    }
    // Drop selections that no longer correspond to an eligible report row.
    const eligibleIds = new Set(actionRows.map((row) => Number(row.id)));
    [...this.selected].forEach((id) => { if (!eligibleIds.has(id)) this.selected.delete(id); });
    this._syncSelectionControls();
  },

  _syncSelectionControls() {
    if (!this.viewEl) return;
    const count = this.viewEl.querySelector('#mSelectedCount');
    const apply = this.viewEl.querySelector('#mBulkApply');
    const selectVisible = this.viewEl.querySelector('#mSelectVisible');
    const checkboxes = [...this.viewEl.querySelectorAll('.m-row-check')];
    if (count) count.textContent = String(this.selected.size);
    if (apply) apply.disabled = this.selected.size === 0;
    if (selectVisible) {
      const checked = checkboxes.filter((checkbox) => checkbox.checked).length;
      selectVisible.checked = checkboxes.length > 0 && checked === checkboxes.length;
      selectVisible.indeterminate = checked > 0 && checked < checkboxes.length;
    }
  },

  async _saveSource(id, button) {
    const input = this.viewEl && this.viewEl.querySelector('#mSource-' + id);
    const source = input ? input.value.trim() : '';
    if (!source) {
      App.ui.toast('Enter the place where this item was bought', 'err');
      if (input) input.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Saving…';
    try {
      await App.pos.margins.setSource(id, source);
      if (!this._isCurrent()) return;
      App.ui.toast('Purchase source saved ✓', 'ok');
      await this._loadReadiness();
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not save purchase source', 'err');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = 'Save';
    }
  },

  async _bulkSave(button) {
    const input = this.viewEl && this.viewEl.querySelector('#mBulkSource');
    const source = input ? input.value.trim() : '';
    const ids = [...this.selected];
    if (!ids.length) {
      App.ui.toast('Select at least one item', 'err');
      return;
    }
    if (!source) {
      App.ui.toast('Enter a purchase source for the selected items', 'err');
      if (input) input.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Applying…';
    try {
      await App.pos.margins.bulkSetSource(ids, source);
      if (!this._isCurrent()) return;
      App.ui.toast(`Purchase source applied to ${ids.length} item${ids.length === 1 ? '' : 's'} ✓`, 'ok');
      await this._loadReadiness();
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not apply purchase source', 'err');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = 'Apply to selected';
    }
  },

  async _generate() {
    const button = this.viewEl && this.viewEl.querySelector('#mGenerate');
    if (!button) return;
    const generation = this._sessionGeneration;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = '<span class="spinner margin-spinner-sm margin-spinner-invert" aria-hidden="true"></span> Generating…';
    try {
      const report = await App.pos.margins.generate();
      if (!this._isCurrent(generation)) return;
      this.reportShown = this.batchSize;
      this.search = '';
      this.sourceFilter = 'all';
      this._setReport(report || { rows: [], summary: {} });
      this._renderReport();
      this._announce('Product margin table generated and ready to download.');
      App.ui.toast('Margin table generated ✓', 'ok');
      const reportRegion = this.viewEl.querySelector('#mReport');
      if (reportRegion) reportRegion.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      App.ui.toast(error.message || 'Could not generate the margin table', 'err');
      // Re-check because prices or stock may have changed after readiness.
      await this._loadReadiness();
    } finally {
      if (!this._isCurrent(generation)) return;
      const currentButton = this.viewEl.querySelector('#mGenerate');
      if (currentButton) {
        const data = this.readiness || {};
        const canGenerate = data.canGenerate === true || data.can_generate === true;
        currentButton.disabled = !canGenerate;
        currentButton.removeAttribute('aria-busy');
        currentButton.textContent = 'Generate Margin Table';
      }
    }
  },

  _renderReport() {
    if (!this.report || !this.viewEl) return;
    const reportRegion = this.viewEl.querySelector('#mReport');
    const summary = this.report.summary || {};
    const rows = this._rows(this.report);
    const sources = [...new Set(rows.map((row) => this._source(row)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const generatedAt = this.report.generatedAt || this.report.generated_at;

    reportRegion.hidden = false;
    reportRegion.innerHTML = `
      <div class="margin-report-divider" aria-hidden="true"><span>Generated report</span></div>
      <header class="margin-report-head">
        <div>
          <span class="margin-section-index" aria-hidden="true">02</span>
          <div>
            <h3>Calculated inventory margin</h3>
            <p>${generatedAt ? `Generated ${App.ui.esc(App.ui.fmtDate(generatedAt))}` : 'Generated from the latest saved product data'} · ${rows.length} product${rows.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        <span class="margin-live-badge"><i aria-hidden="true"></i> Ready to download</span>
      </header>

      <div class="margin-summary-grid" aria-label="Margin table totals">
        <div class="margin-summary-card">
          <span>Included inventory</span>
          <strong>${App.ui.esc(String(this._summaryValue(summary, 'item_count', 'itemCount', rows.length)))}</strong>
          <small>${App.ui.esc(App.ui.qty(this._summaryValue(summary, 'total_stock', 'totalStock', rows.reduce((sum, row) => sum + this._number(row.stock), 0))))} total stock units</small>
        </div>
        <div class="margin-summary-card">
          <span>Computed inventory cost</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'computed_cost', 'computedCost', 0))}</strong>
          <small>Estimated original cost of current stock</small>
        </div>
        <div class="margin-summary-card">
          <span>Retail value</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'retail_value', 'retailValue', 0))}</strong>
          <small>Current stock at selling price</small>
        </div>
        <div class="margin-summary-card is-gross">
          <span>Potential gross profit</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'potential_gross_profit', 'potentialGrossProfit', 0))}</strong>
          <small>If all included stock is sold</small>
        </div>
      </div>

      <div class="margin-report-tools">
        <div class="margin-search-field">
          <label class="margin-sr-only" for="mReportSearch">Search generated table</label>
          <span aria-hidden="true">⌕</span>
          <input type="search" id="mReportSearch" value="${App.ui.esc(this.search)}"
            placeholder="Search item, SKU, unit, or source…">
        </div>
        <div class="margin-filter-field">
          <label for="mSourceFilter">Purchase source</label>
          <select id="mSourceFilter">
            <option value="all">All purchase sources</option>
            ${sources.map((source) => `<option value="${App.ui.esc(source)}" ${source === this.sourceFilter ? 'selected' : ''}>${App.ui.esc(source)}</option>`).join('')}
          </select>
        </div>
        <div class="margin-table-count" id="mTableCount" aria-live="polite"></div>
      </div>

      <div class="margin-result-panel">
        <div class="margin-result-scroll">
          <table class="margin-table margin-result-table">
            <thead>
              <tr>
                <th>Item Name</th>
                <th>Unit</th>
                <th class="right">Stock</th>
                <th>Purchase Source</th>
                <th class="right">Original Cost (Computed)</th>
                <th class="right">Selling Price</th>
                <th class="right">Unit Profit</th>
                <th class="right">Potential Gross</th>
              </tr>
            </thead>
            <tbody id="mTableBody"></tbody>
          </table>
        </div>
        <div id="mTableFooter"></div>
      </div>
      <p class="margin-report-footnote">
        Original cost is computed from the selling price minus the assigned fixed margin. Potential gross profit is stock × unit profit; it is not realized sales profit and does not deduct VAT or operating expenses.
      </p>`;

    const search = reportRegion.querySelector('#mReportSearch');
    const filter = reportRegion.querySelector('#mSourceFilter');
    const debouncedSearch = App.ui.debounce(() => {
      if (!this._isCurrent()) return;
      this.search = search.value.trim();
      this.reportShown = this.batchSize;
      this._renderReportRows();
    }, 160);
    search.addEventListener('input', debouncedSearch);
    filter.addEventListener('change', () => {
      this.sourceFilter = filter.value;
      this.reportShown = this.batchSize;
      this._renderReportRows();
    });
    this._renderReportRows();
  },

  _summaryValue(summary, snake, camel, fallback) {
    if (summary[snake] != null) return summary[snake];
    if (summary[camel] != null) return summary[camel];
    return fallback;
  },

  _filteredReportRows() {
    const rows = this._rows(this.report);
    const query = this.search.toLocaleLowerCase();
    return rows.filter((row) => {
      const source = this._source(row);
      if (this.sourceFilter !== 'all' && source !== this.sourceFilter) return false;
      if (!query) return true;
      const haystack = [
        this._itemName(row),
        this._field(row, 'sku', 'sku', ''),
        this._field(row, 'unit', 'unit', ''),
        source,
      ].join(' ').toLocaleLowerCase();
      return haystack.includes(query);
    });
  },

  _renderReportRows() {
    if (!this.report || !this.viewEl) return;
    const body = this.viewEl.querySelector('#mTableBody');
    const footer = this.viewEl.querySelector('#mTableFooter');
    const count = this.viewEl.querySelector('#mTableCount');
    if (!body || !footer || !count) return;
    const allRows = this._rows(this.report);
    const filtered = this._filteredReportRows();
    const visible = filtered.slice(0, this.reportShown);
    count.textContent = `${filtered.length} of ${allRows.length} items`;

    if (!visible.length) {
      body.innerHTML = `
        <tr><td colspan="8">
          <div class="margin-table-empty">
            <strong>No matching items</strong>
            <span>Try a different search or purchase source.</span>
          </div>
        </td></tr>`;
    } else {
      body.innerHTML = visible.map((row) => `
        <tr>
          <td>
            <strong class="margin-item-name">${App.ui.esc(this._itemName(row))}</strong>
            ${this._field(row, 'sku', 'sku', '') ? `<span class="margin-item-meta">${App.ui.esc(this._field(row, 'sku', 'sku', ''))}</span>` : ''}
          </td>
          <td>${App.ui.esc(this._field(row, 'unit', 'unit', '—'))}</td>
          <td class="right margin-number">${App.ui.esc(App.ui.qty(this._number(this._field(row, 'stock', 'stock', 0))))}</td>
          <td><span class="margin-source-value">${App.ui.esc(this._source(row) || '—')}</span></td>
          <td class="right margin-number">${App.ui.money(this._field(row, 'computed_cost', 'computedCost', 0))}</td>
          <td class="right margin-number">${App.ui.money(this._field(row, 'selling_price', 'sellingPrice', 0))}</td>
          <td class="right margin-number margin-unit-profit">+${App.ui.money(this._field(row, 'unit_profit', 'unitProfit', 0))}</td>
          <td class="right margin-number margin-gross">${App.ui.money(this._field(row, 'potential_gross_profit', 'potentialGrossProfit', 0))}</td>
        </tr>`).join('');
    }

    footer.innerHTML = filtered.length > visible.length ? `
      <div class="margin-load-row">
        <span>Showing ${visible.length} of ${filtered.length} matching items</span>
        <button type="button" class="btn btn-sm btn-ghost" id="mReportMore">Load 100 more</button>
      </div>` : `
      <div class="margin-load-row is-complete">
        <span>${filtered.length ? `All ${filtered.length} matching items are shown` : 'No rows to display'}</span>
      </div>`;
    const more = footer.querySelector('#mReportMore');
    if (more) {
      more.addEventListener('click', () => {
        this.reportShown += this.batchSize;
        this._renderReportRows();
      });
    }
  },

  _toggleDownloadMenu() {
    const button = this.viewEl && this.viewEl.querySelector('#mDownloadBtn');
    const menu = this.viewEl && this.viewEl.querySelector('#mDownloadMenu');
    if (!button || !menu || button.disabled) return;
    const opening = menu.hidden;
    menu.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const first = menu.querySelector('[role="menuitem"]');
      if (first) requestAnimationFrame(() => first.focus());
    }
  },

  _closeDownloadMenu() {
    const button = this.viewEl && this.viewEl.querySelector('#mDownloadBtn');
    const menu = this.viewEl && this.viewEl.querySelector('#mDownloadMenu');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  },

  _onDownloadKeydown(event) {
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      this._closeDownloadMenu();
      const trigger = this.viewEl.querySelector('#mDownloadBtn');
      if (trigger) trigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = (Math.max(0, index) + direction + items.length) % items.length;
      if (items[next]) items[next].focus();
    }
  },

  async _export(format) {
    if (!this.report || !this.viewEl) return;
    const method = format === 'pdf' ? 'exportPdf' : 'exportExcel';
    const label = format === 'pdf' ? 'PDF' : 'Excel';
    const trigger = this.viewEl.querySelector('#mDownloadBtn');
    const menuButtons = [...this.viewEl.querySelectorAll('#mDownloadMenu [data-format]')];
    this._closeDownloadMenu();
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    trigger.innerHTML = `<span class="spinner margin-spinner-sm" aria-hidden="true"></span> Creating ${label}…`;
    menuButtons.forEach((button) => { button.disabled = true; });
    try {
      const result = await App.pos.margins[method]();
      if (!this._isCurrent()) return;
      const canceled = result && (result.canceled === true || result.cancelled === true);
      const path = typeof result === 'string' ? result : (result && (result.path || result.filePath));
      if (!canceled) {
        App.ui.toast(path ? `${label} saved: ${path}` : `${label} file saved ✓`, 'ok');
        this._announce(`${label} download completed.`);
      }
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || `Could not create ${label} file`, 'err');
    } finally {
      if (!this._isCurrent()) return;
      trigger.disabled = !this.report;
      trigger.removeAttribute('aria-busy');
      trigger.innerHTML = '<span aria-hidden="true">↓</span> Download <span class="margin-caret" aria-hidden="true">▾</span>';
      menuButtons.forEach((button) => { button.disabled = false; });
    }
  },
};
