'use strict';
/* Admin: Expenses vs Earnings — one blank for total expenses;
 * earnings = this month's completed sales − expenses. */
window.App = window.App || {};
App.views = App.views || {};

App.views.earnings = {
  title: 'Expenses vs Earnings',
  viewEl: null,

  async render(view) {
    this.viewEl = view;
    view.classList.add('view-earnings');
    view.innerHTML = `
      <div class="reports-page">
        <header class="reports-header">
          <div class="reports-heading">
            <div class="reports-eyebrow">Simple store math</div>
            <h2>Expenses vs Earnings</h2>
            <p>Type your total expenses once — earnings are calculated from this month’s sales.</p>
          </div>
          <div class="reports-actions">
            <button type="button" class="btn btn-sm btn-ghost" id="eRefresh">Refresh</button>
          </div>
        </header>
        <div class="an-cards an-profit-cards" id="eCards" aria-busy="true">
          <div class="an-card muted">Loading…</div>
        </div>
      </div>`;
    view.querySelector('#eRefresh').onclick = () => this._load();
    await this._load();
  },

  destroy() {
    if (this.viewEl) {
      this.viewEl.classList.remove('view-earnings');
      this.viewEl.innerHTML = '';
    }
    this.viewEl = null;
  },

  _parseExpenses(raw) {
    const cleaned = String(raw == null ? '' : raw).replace(/,/g, '').trim();
    if (cleaned === '') return 0;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  },

  _renderCards(monthSales, expenses) {
    const earnings = monthSales - expenses;
    const earningsClass = earnings > 0 ? 'is-profit' : (earnings < 0 ? 'is-loss' : '');
    const earningsHint = earnings > 0
      ? 'You are ahead this month'
      : (earnings < 0 ? 'Expenses are higher than sales' : 'Break even this month');
    const expensesDisplay = expenses > 0 ? String(expenses) : '';
    return `
      <div class="an-card">
        <div class="an-k">This month’s sales</div>
        <div class="an-v">${App.ui.money(monthSales)}</div>
        <div class="an-sub">From completed sales (automatic)</div>
      </div>
      <div class="an-card an-card-expense">
        <div class="an-k">Total expenses</div>
        <div class="an-expense-edit">
          <label class="an-expense-label" for="eExpenseInput">Total expenses</label>
          <div class="an-expense-row">
            <span class="an-expense-prefix" aria-hidden="true">${App.ui.esc(App.currencySymbol || '₱')}</span>
            <input id="eExpenseInput" class="an-expense-input" type="number" min="0" step="0.01" inputmode="decimal"
              placeholder="0.00" value="${App.ui.esc(expensesDisplay)}"
              aria-describedby="eExpenseHint">
            <button type="button" class="btn btn-sm btn-primary" id="eExpenseSave">Save</button>
          </div>
          <p class="an-expense-hint" id="eExpenseHint">Example: rent, salaries, electricity, supplies for this month.</p>
        </div>
      </div>
      <div class="an-card an-card-accent an-card-profit ${earningsClass}">
        <div class="an-k">Earnings</div>
        <div class="an-v">${App.ui.money(earnings)}</div>
        <div class="an-sub">${earningsHint} · Sales − Expenses</div>
      </div>`;
  },

  async _saveExpenses() {
    const input = this.viewEl.querySelector('#eExpenseInput');
    const button = this.viewEl.querySelector('#eExpenseSave');
    if (!input || !button) return;
    const parsed = this._parseExpenses(input.value);
    if (parsed == null) {
      App.ui.toast('Enter a valid expense amount (0 or higher)', 'err');
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await App.pos.settings.set('analytics_total_expenses', String(parsed));
      App.ui.toast('Total expenses saved ✓', 'ok');
      await this._load();
    } catch (e) {
      App.ui.toast(e.message || 'Could not save expenses', 'err');
      button.disabled = false;
      button.textContent = 'Save';
    }
  },

  async _load() {
    const cards = this.viewEl.querySelector('#eCards');
    cards.setAttribute('aria-busy', 'true');
    try {
      const [summary, settings] = await Promise.all([
        App.pos.reports.summary(),
        App.pos.settings.getAll(),
      ]);
      const monthSales = Number((summary && summary.month && summary.month.total) || 0);
      const expenses = this._parseExpenses((settings || {}).analytics_total_expenses) || 0;
      cards.innerHTML = this._renderCards(monthSales, expenses);
      const saveBtn = cards.querySelector('#eExpenseSave');
      if (saveBtn) saveBtn.onclick = () => this._saveExpenses();
      const expenseInput = cards.querySelector('#eExpenseInput');
      if (expenseInput) {
        expenseInput.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._saveExpenses();
          }
        };
      }
    } catch (e) {
      cards.innerHTML = `<div class="an-card muted">${App.ui.esc(e.message || 'Unable to load expenses vs earnings.')}</div>`;
    } finally {
      cards.setAttribute('aria-busy', 'false');
    }
  },
};
