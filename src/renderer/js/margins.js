'use strict';
/* Admin: simple margin table for active, in-stock "Newly Added Items".
 * Selling prices already include profit. Original (puhunan) = selling − fixed margin.
 * Purchase place must be filled before generate. */
window.App = window.App || {};
App.views = App.views || {};

App.views.margins = {
  title: 'Generate Margin Table',
  viewEl: null,
  readiness: null,
  report: null,
  prepRows: [],
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
    this.prepRows = [];
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
            <h2>Generate Margin Table</h2>
            <p>Fill where each item was bought, then generate the table.</p>
          </div>
          <div class="margin-header-actions">
            <button type="button" class="btn btn-sm btn-ghost" id="mRefresh">Refresh</button>
            <div class="margin-download" id="mDownload">
              <button type="button" class="btn btn-sm btn-ghost margin-download-trigger" id="mDownloadBtn"
                aria-haspopup="menu" aria-expanded="false" aria-controls="mDownloadMenu" disabled>
                Download ▾
              </button>
              <div class="margin-download-menu" id="mDownloadMenu" role="menu" hidden>
                <button type="button" role="menuitem" data-format="excel">Excel (.xlsx)</button>
                <button type="button" role="menuitem" data-format="pdf">PDF</button>
              </div>
            </div>
          </div>
        </header>

        <section id="mReadiness" aria-live="polite" aria-busy="true">
          <div class="margin-loading">Loading items…</div>
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
    this.prepRows = [];
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
    return price > 0 && price >= profit;
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

  _allPrepIds() {
    return this.prepRows.map((row) => Number(row.id));
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
      refresh.textContent = 'Refreshing…';
    }
    if (region) {
      region.setAttribute('aria-busy', 'true');
      region.innerHTML = '<div class="margin-loading">Loading items…</div>';
    }

    try {
      const data = await App.pos.margins.readiness();
      if (!this._isCurrent(generation)) return;
      this.readiness = data || {};
      this._renderReadiness();
      this._announce('Items loaded.');
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      const message = error && error.message ? error.message : 'Unable to load items.';
      region.innerHTML = `
        <div class="margin-error" role="alert">
          <div><strong>Could not load items</strong><p>${App.ui.esc(message)}</p></div>
          <button type="button" class="btn btn-sm btn-ghost" id="mRetry">Try again</button>
        </div>`;
      region.querySelector('#mRetry').addEventListener('click', () => this._loadReadiness());
    } finally {
      if (!this._isCurrent(generation)) return;
      region.setAttribute('aria-busy', 'false');
      if (refresh) {
        refresh.disabled = false;
        refresh.textContent = 'Refresh';
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
    const manualCost = this._count(data, 'manualCostCount', 'manual_cost_count')
      || rows.filter((row) => row.needs_manual_cost || row.needsManualCost).length;
    const completedValue = data.completedCount != null ? data.completedCount : data.completed_count;
    const completed = completedValue == null
      ? Math.max(0, eligible - new Set(rows.filter((row) => this._sourceMissing(row) || !this._priceValid(row)).map((row) => row.id)).size)
      : this._number(completedValue);
    const canGenerate = typeof data.canGenerate === 'boolean'
      ? data.canGenerate
      : (typeof data.can_generate === 'boolean' ? data.can_generate : eligible > 0 && missing === 0 && invalid === 0);

    this.prepRows = [...rows].sort((a, b) => {
      const aNeedsAttention = this._sourceMissing(a) || !this._priceValid(a);
      const bNeedsAttention = this._sourceMissing(b) || !this._priceValid(b);
      if (aNeedsAttention !== bNeedsAttention) return aNeedsAttention ? -1 : 1;
      return this._itemName(a).localeCompare(this._itemName(b));
    });
    const visibleRows = this.prepRows.slice(0, this.prepShown);
    const region = this.viewEl.querySelector('#mReadiness');

    let statusText;
    if (eligible === 0) statusText = 'No items with stock in Newly Added Items.';
    else if (!canGenerate && missing) statusText = `Fill place bought for ${missing} item${missing === 1 ? '' : 's'} before generating.`;
    else if (!canGenerate && invalid) statusText = `${invalid} item${invalid === 1 ? '' : 's'} need a selling price above zero.`;
    else if (canGenerate && manualCost) {
      statusText = `Ready to generate · ${manualCost} item${manualCost === 1 ? '' : 's'} under ₱10 will need original price after generate.`;
    } else if (canGenerate) statusText = `All ${eligible} items are ready.`;
    else statusText = `${completed} of ${eligible} ready`;

    region.innerHTML = `
      <div class="margin-toolbar">
        <div class="margin-toolbar-copy">
          <p class="margin-rules-line">
            Profit: ≤ ₱100 = <b>₱10</b> · ₱100–200 = <b>₱15</b> · above ₱200 = <b>₱20</b>
          </p>
          <p class="margin-status-line" id="mGenerateHint">${App.ui.esc(statusText)}</p>
        </div>
        <div class="margin-toolbar-actions">
          <button type="button" class="btn btn-primary margin-generate" id="mGenerate"
            ${canGenerate ? '' : 'disabled'} aria-describedby="mGenerateHint">
            Generate Margin Table
          </button>
        </div>
      </div>

      ${eligible === 0 ? this._emptyReadiness() : this._renderActionPanel(visibleRows)}`;

    const generate = region.querySelector('#mGenerate');
    if (generate) generate.addEventListener('click', () => this._generate());
    if (eligible > 0) this._wireActionPanel();
  },

  _emptyReadiness() {
    return `
      <div class="margin-empty">
        <strong>No items to calculate</strong>
        <p>Add stock under Newly Added Items, then refresh.</p>
        <button type="button" class="btn btn-sm btn-ghost" id="mOpenProducts">Open Products</button>
      </div>`;
  },

  _renderActionPanel(visibleRows) {
    const total = this.prepRows.length;
    const allIds = this._allPrepIds();
    const allSelected = allIds.length > 0 && allIds.every((id) => this.selected.has(id));
    const someSelected = this.selected.size > 0 && !allSelected;
    const sourceSuggestions = [...new Set(this.prepRows.map((row) => this._source(row)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));

    return `
      <section class="margin-action-panel">
        <div class="margin-bulk-bar">
          <label class="margin-select-all-label">
            <input type="checkbox" id="mSelectAll"
              ${allSelected ? 'checked' : ''} ${allIds.length ? '' : 'disabled'}
              ${someSelected ? 'data-indeterminate="1"' : ''}>
            <span>Select all ${total} items</span>
          </label>
          <span class="margin-selection-count"><b id="mSelectedCount">${this.selected.size}</b> selected</span>
          <div class="margin-bulk-field">
            <input id="mBulkSource" type="text" maxlength="200" list="mSourceSuggestions"
              placeholder="Type place bought, then Apply" autocomplete="off">
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
                <th class="margin-check-cell"></th>
                <th>Item name</th>
                <th class="right">Stock</th>
                <th>Place where it is bought</th>
                <th class="right">Selling price</th>
              </tr>
            </thead>
            <tbody>
              ${visibleRows.map((row) => this._renderPrepRow(row)).join('')}
            </tbody>
          </table>
        </div>
        <div class="margin-load-row">
          <span>Showing ${visibleRows.length} of ${total}</span>
          <div class="margin-load-actions">
            ${total > visibleRows.length ? `
              <button type="button" class="btn btn-sm btn-ghost" id="mPrepMore">Show 100 more</button>
              <button type="button" class="btn btn-sm btn-ghost" id="mPrepAll">Show all</button>
            ` : '<span>All items shown</span>'}
          </div>
        </div>
      </section>`;
  },

  _renderPrepRow(row) {
    const id = Number(row.id);
    const sourceMissing = this._sourceMissing(row);
    const priceValid = this._priceValid(row);
    const stock = this._number(this._field(row, 'stock', 'stock', 0));
    const sellingPrice = this._number(this._field(row, 'selling_price', 'sellingPrice', 0));

    return `
      <tr data-product-id="${id}" class="${!priceValid ? 'has-price-error' : ''}${sourceMissing ? ' needs-source' : ''}">
        <td class="margin-check-cell">
          <input type="checkbox" class="m-row-check" value="${id}" aria-label="Select ${App.ui.esc(this._itemName(row))}"
            ${this.selected.has(id) ? 'checked' : ''}>
        </td>
        <td><span class="margin-item-name">${App.ui.esc(this._itemName(row))}</span></td>
        <td class="right margin-number">${App.ui.esc(App.ui.qty(stock))}</td>
        <td>
          <input id="mSource-${id}" class="m-source-input ${sourceMissing ? 'is-required' : ''}"
            type="text" maxlength="200" list="mSourceSuggestions"
            placeholder="Where was this bought?"
            value="${App.ui.esc(this._source(row))}" autocomplete="off"
            aria-label="Place bought for ${App.ui.esc(this._itemName(row))}">
        </td>
        <td class="right margin-number ${priceValid ? '' : 'margin-price-invalid'}">${App.ui.money(sellingPrice)}</td>
      </tr>`;
  },

  _wireActionPanel() {
    const region = this.viewEl.querySelector('#mReadiness');
    const selectAll = region.querySelector('#mSelectAll');
    if (selectAll) {
      if (selectAll.dataset.indeterminate === '1') selectAll.indeterminate = true;
      selectAll.addEventListener('change', () => {
        if (selectAll.checked) {
          this._allPrepIds().forEach((id) => this.selected.add(id));
        } else {
          this.selected.clear();
        }
        region.querySelectorAll('.m-row-check').forEach((checkbox) => {
          checkbox.checked = this.selected.has(Number(checkbox.value));
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

    region.querySelectorAll('.m-source-input').forEach((input) => {
      const id = Number(input.id.replace('mSource-', ''));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this._saveSource(id, input);
        }
      });
      input.addEventListener('blur', () => {
        const current = this._source(this.prepRows.find((row) => Number(row.id) === id));
        if (input.value.trim() && input.value.trim() !== current) this._saveSource(id, input);
      });
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
    const showAll = region.querySelector('#mPrepAll');
    if (showAll) {
      showAll.addEventListener('click', () => {
        this.prepShown = this.prepRows.length;
        this._renderReadiness();
      });
    }

    const eligibleIds = new Set(this._allPrepIds());
    [...this.selected].forEach((id) => { if (!eligibleIds.has(id)) this.selected.delete(id); });
    this._syncSelectionControls();
  },

  _syncSelectionControls() {
    if (!this.viewEl) return;
    const count = this.viewEl.querySelector('#mSelectedCount');
    const apply = this.viewEl.querySelector('#mBulkApply');
    const selectAll = this.viewEl.querySelector('#mSelectAll');
    const allIds = this._allPrepIds();
    if (count) count.textContent = String(this.selected.size);
    if (apply) apply.disabled = this.selected.size === 0;
    if (selectAll && allIds.length) {
      const selectedCount = allIds.filter((id) => this.selected.has(id)).length;
      selectAll.checked = selectedCount === allIds.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < allIds.length;
    }
  },

  async _saveSource(id, input) {
    const source = input ? input.value.trim() : '';
    if (!source) {
      App.ui.toast('Enter where this item was bought', 'err');
      if (input) input.focus();
      return;
    }
    input.disabled = true;
    try {
      await App.pos.margins.setSource(id, source);
      if (!this._isCurrent()) return;
      const keptSelected = new Set(this.selected);
      const keptShown = this.prepShown;
      const data = await App.pos.margins.readiness();
      if (!this._isCurrent()) return;
      this.readiness = data || {};
      this.prepShown = keptShown;
      this.selected = keptSelected;
      this._renderReadiness();
      App.ui.toast('Saved ✓', 'ok');
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not save', 'err');
      input.disabled = false;
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
      App.ui.toast('Type the place bought first', 'err');
      if (input) input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = `Saving ${ids.length}…`;
    try {
      await App.pos.margins.bulkSetSource(ids, source);
      if (!this._isCurrent()) return;
      App.ui.toast(`Saved for ${ids.length} items ✓`, 'ok');
      await this._loadReadiness();
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not apply place bought', 'err');
      button.disabled = false;
      button.textContent = 'Apply to selected';
    }
  },

  async _generate() {
    const button = this.viewEl && this.viewEl.querySelector('#mGenerate');
    if (!button) return;
    const generation = this._sessionGeneration;
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      const report = await App.pos.margins.generate();
      if (!this._isCurrent(generation)) return;
      this.reportShown = this.batchSize;
      this.search = '';
      this.sourceFilter = 'all';
      this._setReport(report || { rows: [], summary: {} });
      this._renderReport();
      this._announce('Margin table generated.');
      App.ui.toast('Margin table generated ✓', 'ok');
      const reportRegion = this.viewEl.querySelector('#mReport');
      if (reportRegion) reportRegion.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      App.ui.toast(error.message || 'Could not generate the margin table', 'err');
      await this._loadReadiness();
    } finally {
      if (!this._isCurrent(generation)) return;
      const currentButton = this.viewEl.querySelector('#mGenerate');
      if (currentButton) {
        const data = this.readiness || {};
        const canGenerate = data.canGenerate === true || data.can_generate === true;
        currentButton.disabled = !canGenerate;
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
    const missingCost = this._number(this._summaryValue(summary, 'missing_cost_count', 'missingCostCount',
      rows.filter((row) => row.needs_manual_cost || row.needsManualCost).length));
    const lowPriceCount = rows.filter((row) => {
      const price = this._number(this._field(row, 'selling_price', 'sellingPrice', 0));
      return price > 0 && price < 10;
    }).length;

    reportRegion.hidden = false;
    reportRegion.innerHTML = `
      <h3 class="margin-report-title">Margin table</h3>
      <p class="margin-manual-note">
        Items with blank puhunan or Baligya under ₱10 are listed first.
        Edit <b>Place</b> or <b>Puhunan</b> below, then download Excel/PDF.
        ${missingCost ? `<br><b>${missingCost}</b> item${missingCost === 1 ? '' : 's'} still need puhunan.` : ''}
        ${lowPriceCount && !missingCost ? `<br>${lowPriceCount} item${lowPriceCount === 1 ? '' : 's'} are under ₱10.` : ''}
      </p>

      <div class="margin-summary-grid">
        <div class="margin-summary-card">
          <span>Total Puhunan (Cost)</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'computed_cost', 'computedCost', 0))}</strong>
        </div>
        <div class="margin-summary-card">
          <span>Total Baligya (Sales)</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'retail_value', 'retailValue', 0))}</strong>
        </div>
        <div class="margin-summary-card is-gross">
          <span>Total Halin (Gross Profit)</span>
          <strong>${App.ui.money(this._summaryValue(summary, 'potential_gross_profit', 'potentialGrossProfit', 0))}</strong>
        </div>
      </div>

      <div class="margin-report-tools">
        <input type="search" id="mReportSearch" value="${App.ui.esc(this.search)}"
          placeholder="Search item or place…">
        <select id="mSourceFilter" aria-label="Filter by place bought">
          <option value="all">All places</option>
          <option value="__needs_puhunan__" ${this.sourceFilter === '__needs_puhunan__' ? 'selected' : ''}>Needs puhunan / under ₱10</option>
          ${sources.map((source) => `<option value="${App.ui.esc(source)}" ${source === this.sourceFilter ? 'selected' : ''}>${App.ui.esc(source)}</option>`).join('')}
        </select>
        <span class="margin-table-count" id="mTableCount"></span>
      </div>

      <div class="margin-result-panel">
        <div class="margin-result-scroll">
          <table class="margin-table margin-result-table">
            <thead>
              <tr>
                <th>Item name</th>
                <th class="right">Stock</th>
                <th>Place where it is bought</th>
                <th class="right">Puhunan (Cost)</th>
                <th class="right">Baligya (Sales)</th>
                <th class="right">Halin (Gross Profit)</th>
              </tr>
            </thead>
            <tbody id="mTableBody"></tbody>
          </table>
        </div>
        <div id="mTableFooter"></div>
      </div>
      <p class="margin-report-footnote">
        Edit place or puhunan, press Enter or click Save. Download uses your latest saved edits.
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

  _needsAttention(row) {
    // Highlight / priority only while puhunan is still blank (under-₱10 items).
    return !!(row.needs_manual_cost || row.needsManualCost);
  },

  _isLowPrice(row) {
    const price = this._number(this._field(row, 'selling_price', 'sellingPrice', 0));
    return price > 0 && price < 10;
  },

  _filteredReportRows() {
    const rows = this._rows(this.report);
    const query = this.search.toLocaleLowerCase();
    return rows.filter((row) => {
      const source = this._source(row);
      if (this.sourceFilter === '__needs_puhunan__') {
        if (!this._needsAttention(row) && !this._isLowPrice(row)) return false;
      } else if (this.sourceFilter !== 'all' && source !== this.sourceFilter) {
        return false;
      }
      if (!query) return true;
      const haystack = [this._itemName(row), source].join(' ').toLocaleLowerCase();
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
    count.textContent = `${filtered.length} of ${allRows.length}`;

    if (!visible.length) {
      body.innerHTML = `
        <tr><td colspan="6">
          <div class="margin-table-empty">No matching items</div>
        </td></tr>`;
    } else {
      body.innerHTML = visible.map((row) => {
        const id = Number(row.id);
        const needsManual = !!(row.needs_manual_cost || row.needsManualCost);
        const lowPrice = this._isLowPrice(row);
        const cost = this._field(row, 'computed_cost', 'computedCost', null);
        const gross = this._field(row, 'potential_gross_profit', 'potentialGrossProfit', null);
        const source = this._source(row);
        const selling = this._field(row, 'selling_price', 'sellingPrice', 0);
        const costValue = cost == null || cost === '' ? '' : String(cost);
        const rowClass = [
          needsManual ? 'needs-manual-cost' : '',
          lowPrice && needsManual ? 'is-low-price-pending' : '',
        ].filter(Boolean).join(' ');
        return `
          <tr class="${rowClass}" data-product-id="${id}">
            <td><span class="margin-item-name">${App.ui.esc(this._itemName(row))}</span></td>
            <td class="right margin-number">${App.ui.esc(App.ui.qty(this._number(this._field(row, 'stock', 'stock', 0))))}</td>
            <td>
              <div class="margin-cost-editor margin-place-editor">
                <input type="text" maxlength="200" class="m-report-source"
                  data-id="${id}" value="${App.ui.esc(source)}"
                  placeholder="Place bought"
                  aria-label="Place bought for ${App.ui.esc(this._itemName(row))}">
                <button type="button" class="btn btn-sm btn-ghost m-source-save-report" data-id="${id}">Save</button>
              </div>
            </td>
            <td class="right">
              <div class="margin-cost-editor">
                <input type="number" min="0" step="0.01" class="m-cost-input ${needsManual ? 'is-required' : ''}"
                  data-id="${id}" value="${App.ui.esc(costValue)}"
                  placeholder="${needsManual ? 'Enter puhunan' : 'Puhunan'}"
                  aria-label="Puhunan for ${App.ui.esc(this._itemName(row))}">
                <button type="button" class="btn btn-sm btn-ghost m-cost-save" data-id="${id}">Save</button>
              </div>
            </td>
            <td class="right margin-number ${lowPrice && needsManual ? 'margin-low-price' : ''}">${App.ui.money(selling)}</td>
            <td class="right margin-number margin-gross">${gross == null || gross === '' ? '—' : App.ui.money(gross)}</td>
          </tr>`;
      }).join('');
    }

    footer.innerHTML = filtered.length > visible.length ? `
      <div class="margin-load-row">
        <span>Showing ${visible.length} of ${filtered.length}</span>
        <div class="margin-load-actions">
          <button type="button" class="btn btn-sm btn-ghost" id="mReportMore">Show 100 more</button>
          <button type="button" class="btn btn-sm btn-ghost" id="mReportAll">Show all</button>
        </div>
      </div>` : `
      <div class="margin-load-row is-complete">
        <span>${filtered.length ? `All ${filtered.length} items shown` : ''}</span>
      </div>`;
    const more = footer.querySelector('#mReportMore');
    if (more) {
      more.addEventListener('click', () => {
        this.reportShown += this.batchSize;
        this._renderReportRows();
      });
    }
    const showAll = footer.querySelector('#mReportAll');
    if (showAll) {
      showAll.addEventListener('click', () => {
        this.reportShown = filtered.length;
        this._renderReportRows();
      });
    }
    this._wireReportEditors();
  },

  _wireReportEditors() {
    const body = this.viewEl && this.viewEl.querySelector('#mTableBody');
    if (!body) return;
    body.querySelectorAll('.m-cost-save').forEach((button) => {
      button.addEventListener('click', () => this._saveOriginalCost(Number(button.dataset.id)));
    });
    body.querySelectorAll('.m-cost-input').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this._saveOriginalCost(Number(input.dataset.id));
        }
      });
    });
    body.querySelectorAll('.m-source-save-report').forEach((button) => {
      button.addEventListener('click', () => this._saveReportSource(Number(button.dataset.id)));
    });
    body.querySelectorAll('.m-report-source').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this._saveReportSource(Number(input.dataset.id));
        }
      });
    });
  },

  async _refreshReportKeepView() {
    const keptSearch = this.search;
    const keptFilter = this.sourceFilter;
    const keptShown = this.reportShown;
    const report = await App.pos.margins.generate();
    if (!this._isCurrent()) return;
    this.search = keptSearch;
    this.sourceFilter = keptFilter;
    this.reportShown = keptShown;
    this._setReport(report || { rows: [], summary: {} });
    this._renderReport();
  },

  async _saveReportSource(id) {
    const input = this.viewEl && this.viewEl.querySelector(`.m-report-source[data-id="${id}"]`);
    if (!input) return;
    const source = input.value.trim();
    if (!source) {
      App.ui.toast('Enter where this item was bought', 'err');
      input.focus();
      return;
    }
    input.disabled = true;
    try {
      await App.pos.margins.setSource(id, source);
      if (!this._isCurrent()) return;
      await this._refreshReportKeepView();
      App.ui.toast('Place bought saved ✓', 'ok');
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not save place bought', 'err');
      input.disabled = false;
    }
  },

  async _saveOriginalCost(id) {
    const input = this.viewEl && this.viewEl.querySelector(`.m-cost-input[data-id="${id}"]`);
    if (!input) return;
    const value = input.value.trim();
    if (!value) {
      App.ui.toast('Enter the puhunan (cost)', 'err');
      input.focus();
      return;
    }
    input.disabled = true;
    try {
      await App.pos.margins.setOriginalCost(id, value);
      if (!this._isCurrent()) return;
      await this._refreshReportKeepView();
      App.ui.toast('Puhunan saved ✓', 'ok');
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || 'Could not save puhunan', 'err');
      input.disabled = false;
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
    trigger.textContent = `Creating ${label}…`;
    menuButtons.forEach((button) => { button.disabled = true; });
    try {
      const result = await App.pos.margins[method]();
      if (!this._isCurrent()) return;
      const canceled = result && (result.canceled === true || result.cancelled === true);
      const path = typeof result === 'string' ? result : (result && (result.path || result.filePath));
      if (!canceled) {
        App.ui.toast(path ? `${label} saved: ${path}` : `${label} saved ✓`, 'ok');
        this._announce(`${label} download completed.`);
      }
    } catch (error) {
      if (!this._isCurrent()) return;
      App.ui.toast(error.message || `Could not create ${label}`, 'err');
    } finally {
      if (!this._isCurrent()) return;
      trigger.disabled = !this.report;
      trigger.textContent = 'Download ▾';
      menuButtons.forEach((button) => { button.disabled = false; });
    }
  },
};
