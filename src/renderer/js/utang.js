'use strict';

window.App = window.App || {};
App.views = App.views || {};

App.views.utang = {
  title: 'Utang / Loans',
  state: { q: '', status: 'all' },
  customers: [],
  summary: null,
  reminder: null,
  online: false,

  get isAdmin() {
    return !!(App.current && App.current.user && App.current.user.role === 'admin');
  },

  _isSessionCurrent(generation) {
    return App.isSessionGenerationCurrent(generation);
  },

  _isViewCurrent(generation, view) {
    return this._isSessionCurrent(generation) && this.viewEl === view && !!view && view.isConnected;
  },

  async render(view) {
    this.viewEl = view;
    view.classList.add('view-utang');
    view.innerHTML = `
      <div class="utang-page">
        <div class="utang-head">
          <div>
            <h2>Customer Loans</h2>
            <p class="muted">Credit customers, purchased items, due dates, payments, and reminders.</p>
          </div>
          <button type="button" class="btn btn-primary" id="utangAdd">Add Customer / Company</button>
        </div>
        <div class="utang-summary" id="utangSummary" aria-live="polite"></div>
        <div class="utang-reminder" id="utangReminder"></div>
        <div class="panel utang-list-panel">
          <div class="utang-toolbar">
            <input id="utangSearch" placeholder="Search customer, phone, loan, or transaction" autocomplete="off" aria-label="Search loan customers">
            <select id="utangStatus" aria-label="Filter loan status">
              <option value="all">All accounts</option>
              <option value="open">Open balances</option>
              <option value="due_soon">Due soon</option>
              <option value="due_today">Due today</option>
              <option value="overdue">Overdue</option>
              <option value="needs_due_date">Due date required</option>
              <option value="invalid_due_date">Invalid due date</option>
              <option value="paid">Paid</option>
            </select>
          </div>
          <div class="utang-table-wrap">
            <table class="utang-table">
              <thead><tr><th>Customer / Company</th><th>Contact</th><th>Status</th><th>Nearest due</th><th class="right">Outstanding</th><th></th></tr></thead>
              <tbody id="utangRows"><tr><td colspan="6"><div class="utang-loading">Loading accounts...</div></td></tr></tbody>
            </table>
          </div>
        </div>
      </div>`;
    this._wire();
    await this._load();
  },

  destroy() {
    this.viewEl = null;
  },

  _wire() {
    const search = this.viewEl.querySelector('#utangSearch');
    const status = this.viewEl.querySelector('#utangStatus');
    search.value = this.state.q;
    status.value = this.state.status;
    const reload = App.ui.debounce(() => {
      this.state.q = search.value;
      this._loadCustomers();
    }, 250);
    search.addEventListener('input', reload);
    status.addEventListener('change', () => {
      this.state.status = status.value;
      this._loadCustomers();
    });
    this.viewEl.querySelector('#utangAdd').onclick = () => this._profileForm();
    this.viewEl.querySelector('#utangRows').addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-customer-id]');
      if (trigger) this._openCustomer(Number(trigger.dataset.customerId));
    });
    this.viewEl.querySelector('#utangReminder').addEventListener('click', async (event) => {
      if (!event.target.closest('#utangRunReminders')) return;
      const generation = App.captureSessionGeneration();
      const view = this.viewEl;
      const button = event.target.closest('#utangRunReminders');
      button.disabled = true;
      button.textContent = 'Checking...';
      try {
        const result = await App.pos.loans.runReminders();
        if (!this._isViewCurrent(generation, view)) return;
        App.ui.toast(`Reminder check complete: ${result.sent || 0} sent`, 'ok');
        await this._loadReminder();
      } catch (error) {
        if (this._isViewCurrent(generation, view)) App.ui.toast(error.message, 'err');
      } finally {
        if (this._isViewCurrent(generation, view) && button.isConnected) {
          button.disabled = false;
          button.textContent = 'Check reminders now';
        }
      }
    });
  },

  async _load() {
    await Promise.all([this._loadSummary(), this._loadCustomers(), this._loadReminder()]);
  },

  async _loadSummary() {
    const generation = App.captureSessionGeneration();
    const view = this.viewEl;
    try {
      const summary = await App.pos.loans.summary();
      if (!this._isViewCurrent(generation, view)) return;
      this.summary = summary;
      view.querySelector('#utangSummary').innerHTML = `
        <div class="utang-stat"><span>Total outstanding</span><b>${App.ui.money(summary.total_outstanding)}</b></div>
        <div class="utang-stat"><span>Open loans</span><b>${summary.open_loans}</b></div>
        <div class="utang-stat due"><span>Due within 15 days</span><b>${summary.due_soon + summary.due_today}</b></div>
        <div class="utang-stat overdue"><span>Overdue</span><b>${summary.overdue}</b></div>`;
    } catch (error) {
      if (this._isViewCurrent(generation, view)) {
        view.querySelector('#utangSummary').innerHTML = `<div class="utang-error">${App.ui.esc(error.message)}</div>`;
      }
    }
  },

  async _loadCustomers() {
    const generation = App.captureSessionGeneration();
    const view = this.viewEl;
    if (!this._isViewCurrent(generation, view)) return;
    const rows = view.querySelector('#utangRows');
    rows.innerHTML = '<tr><td colspan="6"><div class="utang-loading">Loading accounts...</div></td></tr>';
    try {
      const customers = await App.pos.loans.listCustomers({ q: this.state.q, status: this.state.status });
      if (!this._isViewCurrent(generation, view)) return;
      this.customers = customers;
      if (!customers.length) {
        rows.innerHTML = `<tr><td colspan="6"><div class="utang-empty"><b>No accounts found</b><span>Add a customer/company or change the search filter.</span></div></td></tr>`;
        return;
      }
      rows.innerHTML = customers.map((customer) => `
        <tr class="${customer.active ? '' : 'is-inactive'}">
          <td><button type="button" class="utang-name" data-customer-id="${customer.id}">${App.ui.esc(customer.name)}</button><small>${customer.entity_kind === 'company' ? 'Company' : 'Individual'}${customer.active ? '' : ' - Inactive'}</small></td>
          <td>${App.ui.esc(customer.contact_person || customer.phone || 'No contact')}<small>${customer.contact_person && customer.phone ? App.ui.esc(customer.phone) : ''}</small></td>
          <td><span class="utang-status ${App.ui.esc(customer.account_status)}">${App.ui.esc(customer.account_status_label)}</span></td>
          <td>${customer.nearest_due_date ? this._dateOnly(customer.nearest_due_date) : '—'}</td>
          <td class="right utang-money">${App.ui.money(customer.outstanding)}</td>
          <td><button type="button" class="btn btn-sm btn-ghost" data-customer-id="${customer.id}">View</button></td>
        </tr>`).join('');
    } catch (error) {
      if (this._isViewCurrent(generation, view)) {
        rows.innerHTML = `<tr><td colspan="6"><div class="utang-error">${App.ui.esc(error.message)}</div></td></tr>`;
      }
    }
  },

  async _loadReminder() {
    const generation = App.captureSessionGeneration();
    const view = this.viewEl;
    try {
      const [status, online] = await Promise.all([
        App.pos.loans.reminderStatus(),
        App.pos.telegram.isOnline().catch(() => false),
      ]);
      if (!this._isViewCurrent(generation, view)) return;
      this.reminder = status;
      this.online = !!online;
      let message;
      let kind = 'ok';
      if (!status.enabled) { message = 'Telegram loan reminders are disabled in Settings.'; kind = 'warn'; }
      else if (!status.configured) { message = 'Telegram token or chat ID is not configured.'; kind = 'warn'; }
      else if (!online) { message = 'Offline: reminders will retry when this POS is online.'; kind = 'warn'; }
      else if (status.last_sent_at) { message = `Reminders active. Last sent ${App.ui.fmtDate(status.last_sent_at)}.`; }
      else { message = 'Reminders active. Eligible loans are checked automatically every 30 minutes.'; }
      const manual = this.isAdmin && status.enabled && status.configured
        ? '<button type="button" class="btn btn-sm btn-ghost" id="utangRunReminders">Check reminders now</button>'
        : '';
      view.querySelector('#utangReminder').innerHTML = `
        <div class="utang-reminder-card ${kind}"><div><b>Telegram reminders</b><span>${App.ui.esc(message)}</span>${status.last_error ? `<small>Last issue: ${App.ui.esc(status.last_error)}</small>` : ''}</div>${manual}</div>`;
    } catch (error) {
      if (this._isViewCurrent(generation, view)) {
        view.querySelector('#utangReminder').innerHTML = `<div class="utang-reminder-card warn">Reminder status unavailable: ${App.ui.esc(error.message)}</div>`;
      }
    }
  },

  _dateOnly(value) {
    if (!value) return '—';
    const parts = String(value).split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return App.ui.esc(value);
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: '2-digit' });
  },

  _profileForm(profile = null, onSaved = null) {
    const generation = App.captureSessionGeneration();
    const editing = !!profile;
    const current = profile || {};
    const m = App.ui.modal({
      title: editing ? 'Edit Customer / Company' : 'Add Customer / Company',
      wide: true,
      closeOnOverlay: false,
      bodyHtml: `<form id="utangProfileForm" class="utang-form">
        <div class="utang-form-grid">
          <div class="field"><label class="fl">Account type</label><select id="upKind"><option value="individual" ${current.entity_kind !== 'company' ? 'selected' : ''}>Individual</option><option value="company" ${current.entity_kind === 'company' ? 'selected' : ''}>Company</option></select></div>
          <div class="field"><label class="fl">Customer / company name</label><input id="upName" maxlength="160" value="${App.ui.esc(current.name || '')}" required autofocus></div>
          <div class="field"><label class="fl">Contact person</label><input id="upContact" maxlength="160" value="${App.ui.esc(current.contact_person || '')}"></div>
          <div class="field"><label class="fl">Phone</label><input id="upPhone" maxlength="60" value="${App.ui.esc(current.phone || '')}"></div>
          <div class="field"><label class="fl">Email</label><input id="upEmail" type="email" maxlength="160" value="${App.ui.esc(current.email || '')}"></div>
          <div class="field"><label class="fl">Credit limit</label><input id="upLimit" type="number" min="0" step="0.01" value="${Number(current.credit_limit || 0).toFixed(2)}" required></div>
          <div class="field utang-span-2"><label class="fl">Address</label><textarea id="upAddress" maxlength="500" rows="2">${App.ui.esc(current.address || '')}</textarea></div>
          <div class="field utang-span-2"><label class="fl">Notes</label><textarea id="upNotes" maxlength="1500" rows="3">${App.ui.esc(current.notes || '')}</textarea></div>
        </div>
      </form>`,
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-primary" data-a="save">Save account</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    const save = async () => {
      const payload = {
        entity_kind: m.el.querySelector('#upKind').value,
        name: m.el.querySelector('#upName').value,
        contact_person: m.el.querySelector('#upContact').value,
        phone: m.el.querySelector('#upPhone').value,
        email: m.el.querySelector('#upEmail').value,
        address: m.el.querySelector('#upAddress').value,
        notes: m.el.querySelector('#upNotes').value,
        credit_limit: m.el.querySelector('#upLimit').value,
      };
      const button = m.el.querySelector('[data-a="save"]');
      button.disabled = true;
      button.textContent = 'Saving...';
      try {
        const saved = editing
          ? await App.pos.loans.updateCustomer(current.id, payload)
          : await App.pos.loans.createCustomer(payload);
        if (!this._isSessionCurrent(generation)) return;
        m.close();
        App.ui.toast(editing ? 'Account updated' : 'Credit customer added', 'ok');
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (!this._isSessionCurrent(generation)) return;
        if (onSaved) await onSaved(saved);
      } catch (error) {
        if (!this._isSessionCurrent(generation)) return;
        App.ui.toast(error.message, 'err');
        button.disabled = false;
        button.textContent = 'Save account';
      }
    };
    m.el.querySelector('[data-a="save"]').onclick = save;
    m.el.querySelector('#utangProfileForm').addEventListener('submit', (event) => { event.preventDefault(); save(); });
  },

  async _openCustomer(customerId) {
    const generation = App.captureSessionGeneration();
    const view = this.viewEl;
    try {
      const detail = await App.pos.loans.getCustomer(customerId);
      if (!this._isViewCurrent(generation, view)) return;
      const customer = detail.customer;
      const adminActions = this.isAdmin ? `
        <button type="button" class="btn btn-sm btn-ghost" data-action="edit-profile">Edit profile</button>
        <button type="button" class="btn btn-sm ${customer.active ? 'btn-ghost' : 'btn-primary'}" data-action="toggle-active">${customer.active ? 'Deactivate' : 'Reactivate'}</button>` : '';
      const m = App.ui.modal({
        title: customer.name,
        wide: true,
        closeOnOverlay: false,
        bodyHtml: `<div class="utang-detail">
          <div class="utang-profile-card">
            <div class="utang-profile-main">
              <span class="utang-kicker">${customer.entity_kind === 'company' ? 'Company account' : 'Individual account'}${customer.active ? '' : ' - Inactive'}</span>
              <div class="utang-profile-grid">
                <div><small>Contact person</small><b>${App.ui.esc(customer.contact_person || '—')}</b></div>
                <div><small>Phone</small><b>${App.ui.esc(customer.phone || '—')}</b></div>
                <div><small>Email</small><b>${App.ui.esc(customer.email || '—')}</b></div>
                <div><small>Address</small><b>${App.ui.esc(customer.address || '—')}</b></div>
              </div>
              ${customer.notes ? `<div class="utang-notes"><small>Notes</small><p>${App.ui.esc(customer.notes)}</p></div>` : ''}
            </div>
            <div class="utang-credit-card">
              <span>Outstanding</span><b>${App.ui.money(detail.totals.outstanding)}</b>
              <div><small>Credit limit</small><strong>${App.ui.money(customer.credit_limit)}</strong></div>
              <div><small>Available</small><strong>${App.ui.money(customer.available_credit)}</strong></div>
            </div>
          </div>
          <div class="utang-detail-actions">${adminActions}</div>
          <div class="utang-loan-list">
            ${detail.loans.length ? detail.loans.map((loan) => this._loanHtml(loan)).join('') : '<div class="utang-empty"><b>No loan history</b><span>Select this customer during an On-Account sale to create a loan.</span></div>'}
          </div>
        </div>`,
        footerHtml: '<button type="button" class="btn btn-ghost" data-a="close">Close</button>',
      });
      m.el.querySelector('.modal').style.width = 'min(1040px, calc(100vw - 36px))';
      m.el.querySelector('[data-a="close"]').onclick = () => m.close();
      m.el.addEventListener('click', (event) => this._detailAction(event, m, detail));
    } catch (error) {
      if (this._isViewCurrent(generation, view)) App.ui.toast(error.message, 'err');
    }
  },

  _loanHtml(loan) {
    const open = loan.state === 'open' && Number(loan.balance) > 0;
    const admin = this.isAdmin;
    const items = loan.items && loan.items.length
      ? `<table class="utang-items"><thead><tr><th>Item</th><th>Qty / unit</th><th class="right">Unit price</th><th class="right">Amount</th></tr></thead><tbody>${loan.items.map((item) => `<tr><td>${App.ui.esc(item.name)}<small>${App.ui.esc(item.sku || '')}</small></td><td>${App.ui.qty(item.qty)} ${App.ui.esc(item.unit)}</td><td class="right">${App.ui.money(item.unit_price)}</td><td class="right">${App.ui.money(item.amount)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="utang-subempty">No item details for this legacy balance.</div>';
    const payments = loan.payments && loan.payments.length
      ? loan.payments.map((payment) => `<div class="utang-payment ${payment.reversed_at ? 'is-reversed' : ''}">
          <div><b>${App.ui.money(payment.amount)}</b><span>${App.ui.esc(String(payment.payment_method || '').toUpperCase())}${payment.reference ? ' - ' + App.ui.esc(payment.reference) : ''}</span><small>${App.ui.fmtDate(payment.paid_at)} by ${App.ui.esc(payment.received_by_name)}</small>${payment.note ? `<small>${App.ui.esc(payment.note)}</small>` : ''}${payment.reversed_at ? `<em>Reversed ${App.ui.fmtDate(payment.reversed_at)}: ${App.ui.esc(payment.reversal_reason || '')}</em>` : ''}</div>
          ${admin && !payment.reversed_at && loan.state !== 'cancelled' ? `<button type="button" class="btn btn-sm btn-ghost" data-action="reverse-payment" data-payment-id="${payment.id}" data-loan-id="${loan.id}">Reverse</button>` : ''}
        </div>`).join('')
      : '<div class="utang-subempty">No payments recorded.</div>';
    const events = loan.events && loan.events.length
      ? loan.events.slice(0, 8).map((event) => `<li><b>${App.ui.esc(String(event.event_type).replace(/_/g, ' '))}</b><span>${App.ui.fmtDate(event.created_at)}${event.actor_name ? ' by ' + App.ui.esc(event.actor_name) : ''}${event.reason ? ' - ' + App.ui.esc(event.reason) : ''}${event.amount_delta != null ? ' (' + App.ui.money(event.amount_delta) + ')' : ''}</span></li>`).join('')
      : '<li><span>No account events.</span></li>';
    return `<article class="utang-loan" data-loan-id="${loan.id}">
      <header>
        <div><span class="utang-kicker">${App.ui.esc(loan.loan_number)}${loan.sale && loan.sale.txn_id ? ' - ' + App.ui.esc(loan.sale.txn_id) : ' - Legacy Balance'}</span><h3>${loan.due_date ? 'Due ' + this._dateOnly(loan.due_date) : 'Due date required'}</h3></div>
        <span class="utang-status ${App.ui.esc(loan.status)}">${App.ui.esc(loan.status_label)}</span>
      </header>
      <div class="utang-loan-totals">
        <div><small>Principal</small><b>${App.ui.money(loan.principal)}</b></div>
        <div><small>Payments</small><b>${App.ui.money(loan.amount_paid)}</b></div>
        <div><small>Outstanding</small><b>${App.ui.money(loan.balance)}</b></div>
      </div>
      <div class="utang-loan-actions">
        ${open ? `<button type="button" class="btn btn-sm btn-primary" data-action="record-payment" data-loan-id="${loan.id}">Record payment</button>` : ''}
        ${admin && loan.state !== 'cancelled' ? `<button type="button" class="btn btn-sm btn-ghost" data-action="set-due" data-loan-id="${loan.id}" data-due-date="${App.ui.esc(loan.due_date || '')}">Set due date</button><button type="button" class="btn btn-sm btn-ghost" data-action="adjust" data-loan-id="${loan.id}">Adjust balance</button>` : ''}
      </div>
      <details class="utang-fold"><summary>Purchased items (${loan.items ? loan.items.length : 0})</summary>${items}</details>
      <details class="utang-fold"><summary>Payments (${loan.payments ? loan.payments.length : 0})</summary><div class="utang-payments">${payments}</div></details>
      <details class="utang-fold"><summary>Account history</summary><ul class="utang-events">${events}</ul></details>
    </article>`;
  },

  async _detailAction(event, modal, detail) {
    const generation = App.captureSessionGeneration();
    const button = event.target.closest('[data-action]');
    if (!button || !this._isSessionCurrent(generation)) return;
    const action = button.dataset.action;
    const customer = detail.customer;
    if (action === 'edit-profile' && this.isAdmin) {
      modal.close();
      this._profileForm(customer, () => this._openCustomer(customer.id));
    } else if (action === 'toggle-active' && this.isAdmin) {
      const ok = await App.ui.confirm(`${customer.active ? 'Deactivate' : 'Reactivate'} ${customer.name}?`, { title: 'Change account status', okText: customer.active ? 'Deactivate' : 'Reactivate' });
      if (!ok || !this._isSessionCurrent(generation)) return;
      try {
        await App.pos.loans.setCustomerActive(customer.id, !customer.active);
        if (!this._isSessionCurrent(generation)) return;
        modal.close();
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (this._isSessionCurrent(generation)) this._openCustomer(customer.id);
      } catch (error) {
        if (this._isSessionCurrent(generation)) App.ui.toast(error.message, 'err');
      }
    } else if (action === 'record-payment') {
      this._paymentForm(Number(button.dataset.loanId), customer.id, modal);
    } else if (action === 'set-due' && this.isAdmin) {
      this._dueDateForm(Number(button.dataset.loanId), button.dataset.dueDate, customer.id, modal);
    } else if (action === 'adjust' && this.isAdmin) {
      this._adjustmentForm(Number(button.dataset.loanId), customer.id, modal);
    } else if (action === 'reverse-payment' && this.isAdmin) {
      this._reversalForm(Number(button.dataset.paymentId), customer.id, modal);
    }
  },

  _paymentForm(loanId, customerId, parentModal) {
    const generation = App.captureSessionGeneration();
    const m = App.ui.modal({
      title: 'Record Loan Payment',
      closeOnOverlay: false,
      bodyHtml: `<div class="utang-form"><div class="field"><label class="fl">Amount received</label><input id="ulpAmount" type="number" min="0.01" step="0.01" autofocus></div><div class="field"><label class="fl">Payment method</label><select id="ulpMethod"><option value="cash">Cash</option><option value="card">Card</option><option value="ewallet">E-Wallet</option><option value="bank">Bank transfer</option><option value="other">Other</option></select></div><div class="field"><label class="fl">Reference</label><input id="ulpReference" maxlength="160"></div><div class="field"><label class="fl">Note</label><textarea id="ulpNote" maxlength="500" rows="2"></textarea></div></div>`,
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-primary" data-a="save">Record payment</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await App.pos.loans.recordPayment(loanId, {
          amount: m.el.querySelector('#ulpAmount').value,
          payment_method: m.el.querySelector('#ulpMethod').value,
          reference: m.el.querySelector('#ulpReference').value,
          note: m.el.querySelector('#ulpNote').value,
        });
        if (!this._isSessionCurrent(generation)) return;
        m.close(); parentModal.close();
        App.ui.toast('Payment recorded', 'ok');
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (this._isSessionCurrent(generation)) this._openCustomer(customerId);
      } catch (error) {
        if (!this._isSessionCurrent(generation)) return;
        App.ui.toast(error.message, 'err'); button.disabled = false;
      }
    };
  },

  _dueDateForm(loanId, currentDate, customerId, parentModal) {
    const generation = App.captureSessionGeneration();
    const m = App.ui.modal({
      title: 'Set Loan Due Date',
      closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Due date</label><input id="uldDate" type="date" value="${App.ui.esc(currentDate || App.ui.todayISO())}" autofocus></div><div class="field"><label class="fl">Reason / note</label><input id="uldReason" maxlength="500" placeholder="Due date agreed with customer"></div>`,
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-primary" data-a="save">Save due date</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await App.pos.loans.setDueDate(loanId, m.el.querySelector('#uldDate').value, m.el.querySelector('#uldReason').value);
        if (!this._isSessionCurrent(generation)) return;
        m.close(); parentModal.close();
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (this._isSessionCurrent(generation)) this._openCustomer(customerId);
      } catch (error) {
        if (!this._isSessionCurrent(generation)) return;
        App.ui.toast(error.message, 'err'); button.disabled = false;
      }
    };
  },

  _adjustmentForm(loanId, customerId, parentModal) {
    const generation = App.captureSessionGeneration();
    const m = App.ui.modal({
      title: 'Adjust Loan Balance',
      closeOnOverlay: false,
      bodyHtml: '<div class="hint" style="margin-bottom:10px">Use a positive amount to add debt or a negative amount to reduce it. Every adjustment is audited.</div><div class="field"><label class="fl">Signed amount</label><input id="ulaDelta" type="number" step="0.01" placeholder="Example: -100.00" autofocus></div><div class="field"><label class="fl">Reason</label><textarea id="ulaReason" maxlength="500" rows="2" required></textarea></div>',
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-primary" data-a="save">Apply adjustment</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await App.pos.loans.adjustBalance(loanId, m.el.querySelector('#ulaDelta').value, m.el.querySelector('#ulaReason').value);
        if (!this._isSessionCurrent(generation)) return;
        m.close(); parentModal.close();
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (this._isSessionCurrent(generation)) this._openCustomer(customerId);
      } catch (error) {
        if (!this._isSessionCurrent(generation)) return;
        App.ui.toast(error.message, 'err'); button.disabled = false;
      }
    };
  },

  _reversalForm(paymentId, customerId, parentModal) {
    const generation = App.captureSessionGeneration();
    const m = App.ui.modal({
      title: 'Reverse Payment',
      closeOnOverlay: false,
      bodyHtml: '<div class="hint" style="margin-bottom:10px">The payment remains in account history and the amount is restored to the loan balance.</div><div class="field"><label class="fl">Reversal reason</label><textarea id="ulrReason" maxlength="500" rows="3" required autofocus></textarea></div>',
      footerHtml: '<button type="button" class="btn btn-ghost" data-a="cancel">Cancel</button><button type="button" class="btn btn-danger" data-a="save">Reverse payment</button>',
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="save"]').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await App.pos.loans.reversePayment(paymentId, m.el.querySelector('#ulrReason').value);
        if (!this._isSessionCurrent(generation)) return;
        m.close(); parentModal.close();
        App.ui.toast('Payment reversed', 'ok');
        await Promise.all([this._loadCustomers(), this._loadSummary()]);
        if (this._isSessionCurrent(generation)) this._openCustomer(customerId);
      } catch (error) {
        if (!this._isSessionCurrent(generation)) return;
        App.ui.toast(error.message, 'err'); button.disabled = false;
      }
    };
  },
};
