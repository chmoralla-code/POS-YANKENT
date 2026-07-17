'use strict';

const {
  PAYMENT_METHODS,
  integerId,
  requiredText,
  optionalText,
  positiveMoney,
  parseDateOnly,
  deriveLoanStatus,
  validateProfile,
  normalizeCustomer,
  insertLoanEvent,
  reconcileCustomerCredit,
  hydrateLoan,
  setLoanBalance,
} = require('../lib/loans');
const { round2 } = require('../lib/money');

function customerOrThrow(db, value) {
  const id = integerId(value, 'Customer');
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!customer) throw new Error('Customer not found');
  return customer;
}

function loanOrThrow(db, value) {
  const id = integerId(value, 'Loan');
  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(id);
  if (!loan) throw new Error('Loan not found');
  return loan;
}

function customerLoanSummary(db, customer) {
  const loans = db.prepare(`SELECT l.id,l.loan_number,l.balance,l.due_date,l.state,s.txn_id
    FROM loans l LEFT JOIN sales s ON s.id=l.sale_id
    WHERE l.customer_id=? ORDER BY l.created_at DESC,l.id DESC`).all(customer.id);
  let outstanding = 0;
  let nearestDueDate = null;
  let openLoans = 0;
  const statuses = [];
  for (const loan of loans) {
    const loanStatus = deriveLoanStatus(loan);
    if (loan.state === 'open' && Number(loan.balance) > 0) {
      outstanding = round2(outstanding + Number(loan.balance));
      openLoans++;
      if (loan.due_date && loanStatus.key !== 'invalid_due_date' && (!nearestDueDate || loan.due_date < nearestDueDate)) {
        nearestDueDate = loan.due_date;
      }
    }
    statuses.push(loanStatus);
  }
  const priority = ['overdue', 'due_today', 'invalid_due_date', 'due_soon', 'needs_due_date', 'open', 'paid', 'cancelled'];
  const accountStatus = priority.find((key) => statuses.some((status) => status.key === key)) || 'no_loans';
  const status = statuses.find((entry) => entry.key === accountStatus) || { key: 'no_loans', label: 'No Loans', days: null };
  return {
    ...normalizeCustomer(customer),
    outstanding,
    nearest_due_date: nearestDueDate,
    open_loans: openLoans,
    loan_count: loans.length,
    account_status: status.key,
    account_status_label: status.label,
    _search_refs: loans.map((loan) => `${loan.loan_number || ''} ${loan.txn_id || ''}`).join(' ').toLowerCase(),
  };
}

function listCustomerSummaries(db, filters = {}) {
  const rows = db.prepare(`SELECT * FROM customers WHERE type='contractor' ORDER BY name COLLATE NOCASE,id`).all();
  let summaries = rows.map((row) => customerLoanSummary(db, row));
  const query = String(filters.q || '').trim().toLowerCase();
  if (query) {
    summaries = summaries.filter((row) => [
      row.name,
      row.contact_person,
      row.phone,
      row.email,
      row.address,
      row._search_refs,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }
  const status = String(filters.status || 'all');
  if (status !== 'all') {
    if (status === 'open') {
      summaries = summaries.filter((row) => row.open_loans > 0);
    } else {
      summaries = summaries.filter((row) => row.account_status === status);
    }
  }
  if (filters.activeOnly) summaries = summaries.filter((row) => row.active);
  summaries.sort((a, b) => {
    const priority = { overdue: 0, due_today: 1, invalid_due_date: 2, due_soon: 3, needs_due_date: 4, open: 5, paid: 6, no_loans: 7, cancelled: 8 };
    const byStatus = (priority[a.account_status] ?? 99) - (priority[b.account_status] ?? 99);
    if (byStatus) return byStatus;
    if (b.outstanding !== a.outstanding) return b.outstanding - a.outstanding;
    return a.name.localeCompare(b.name);
  });
  return summaries.map(({ _search_refs, ...row }) => row);
}

function register(ipcMain, ctx) {
  const { db, guard } = ctx;

  guard(ipcMain, 'pos:loans:summary', { auth: true }, () => {
    const rows = db.prepare('SELECT id,balance,due_date,state FROM loans').all();
    const result = {
      total_outstanding: 0,
      open_loans: 0,
      due_soon: 0,
      due_today: 0,
      overdue: 0,
      needs_due_date: 0,
      invalid_due_date: 0,
      paid: 0,
    };
    for (const row of rows) {
      const status = deriveLoanStatus(row);
      if (row.state === 'open' && Number(row.balance) > 0) {
        result.total_outstanding = round2(result.total_outstanding + Number(row.balance));
        result.open_loans++;
      }
      if (Object.prototype.hasOwnProperty.call(result, status.key)) result[status.key]++;
    }
    return result;
  });

  guard(ipcMain, 'pos:loans:listCustomers', { auth: true }, (_context, filters = {}) =>
    listCustomerSummaries(db, filters || {})
  );

  guard(ipcMain, 'pos:loans:getCustomer', { auth: true }, (_context, customerId) => {
    const customer = customerOrThrow(db, customerId);
    const loans = db.prepare('SELECT * FROM loans WHERE customer_id=? ORDER BY created_at DESC,id DESC')
      .all(customer.id).map((loan) => hydrateLoan(db, loan));
    return {
      customer: customerLoanSummary(db, customer),
      loans,
      totals: {
        outstanding: round2(loans.reduce((sum, loan) => sum + (loan.state === 'open' ? Number(loan.balance) : 0), 0)),
        principal: round2(loans.reduce((sum, loan) => sum + Number(loan.principal || 0), 0)),
        paid: round2(loans.reduce((sum, loan) => sum + Number(loan.amount_paid || 0), 0)),
      },
    };
  });

  guard(ipcMain, 'pos:loans:get', { auth: true }, (_context, loanId) => {
    const loan = hydrateLoan(db, loanId);
    if (!loan) throw new Error('Loan not found');
    return loan;
  });

  // Both cashiers and administrators can register a credit customer. Editing
  // an established profile remains administrator-only below.
  guard(ipcMain, 'pos:loans:createCustomer', { auth: true }, (_context, input = {}) => {
    const profile = validateProfile(input);
    const duplicate = db.prepare(`SELECT id FROM customers
      WHERE type='contractor' AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND active=1`).get(profile.name);
    if (duplicate) throw new Error('An active credit customer/company with this name already exists');
    const info = db.prepare(`INSERT INTO customers(
      name,type,entity_kind,contact_person,phone,email,address,notes,
      credit_limit,credit_used,active,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,0,1,datetime('now'))`).run(
      profile.name,
      profile.type,
      profile.entity_kind,
      profile.contact_person,
      profile.phone,
      profile.email,
      profile.address,
      profile.notes,
      profile.credit_limit
    );
    return normalizeCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid));
  });

  guard(ipcMain, 'pos:loans:updateCustomer', { admin: true }, (_context, customerId, input = {}) => {
    const current = customerOrThrow(db, customerId);
    const profile = validateProfile(input);
    if (profile.credit_limit + 1e-9 < Number(current.credit_used || 0)) {
      throw new Error('Credit limit cannot be lower than the current outstanding balance');
    }
    const duplicate = db.prepare(`SELECT id FROM customers
      WHERE type='contractor' AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND id!=? AND active=1`)
      .get(profile.name, current.id);
    if (duplicate) throw new Error('An active credit customer/company with this name already exists');
    db.prepare(`UPDATE customers SET name=?,type='contractor',entity_kind=?,contact_person=?,
      phone=?,email=?,address=?,notes=?,credit_limit=?,updated_at=datetime('now') WHERE id=?`).run(
      profile.name,
      profile.entity_kind,
      profile.contact_person,
      profile.phone,
      profile.email,
      profile.address,
      profile.notes,
      profile.credit_limit,
      current.id
    );
    return normalizeCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(current.id));
  });

  guard(ipcMain, 'pos:loans:setCustomerActive', { admin: true }, (_context, customerId, active) => {
    const customer = customerOrThrow(db, customerId);
    const nextActive = active ? 1 : 0;
    if (nextActive) {
      const duplicate = db.prepare(`SELECT id FROM customers
        WHERE type='contractor' AND LOWER(TRIM(name))=LOWER(TRIM(?)) AND id!=? AND active=1`)
        .get(customer.name, customer.id);
      if (duplicate) throw new Error('Another active credit customer/company already uses this name');
    }
    db.prepare("UPDATE customers SET active=?,updated_at=datetime('now') WHERE id=?")
      .run(nextActive, customer.id);
    return normalizeCustomer(db.prepare('SELECT * FROM customers WHERE id=?').get(customer.id));
  });

  guard(ipcMain, 'pos:loans:recordPayment', { auth: true }, ({ session }, loanId, input = {}) => {
    const amount = positiveMoney(input.amount, 'Payment amount');
    const method = String(input.payment_method || input.paymentMethod || '').trim().toLowerCase();
    if (!PAYMENT_METHODS.has(method)) throw new Error('Unsupported payment method');
    const reference = optionalText(input.reference, 'Reference', 160);
    const note = optionalText(input.note, 'Payment note', 500);
    let paymentId;
    db.transaction(() => {
      const loan = loanOrThrow(db, loanId);
      if (loan.state !== 'open' || Number(loan.balance) <= 0) throw new Error('This loan has no open balance');
      if (amount > Number(loan.balance) + 1e-9) throw new Error('Payment exceeds the outstanding balance');
      const info = db.prepare(`INSERT INTO loan_payments(
        loan_id,customer_id,amount,payment_method,reference,note,received_by,received_by_name
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        loan.id,
        loan.customer_id,
        amount,
        method,
        reference || null,
        note || null,
        session.id,
        session.full_name
      );
      paymentId = Number(info.lastInsertRowid);
      setLoanBalance(db, loan, round2(Number(loan.balance) - amount));
      reconcileCustomerCredit(db, loan.customer_id);
    })();
    const payment = db.prepare('SELECT * FROM loan_payments WHERE id=?').get(paymentId);
    return { payment, loan: hydrateLoan(db, payment.loan_id) };
  });

  guard(ipcMain, 'pos:loans:setDueDate', { admin: true }, ({ session }, loanId, dueDateValue, reasonValue) => {
    const dueDate = parseDateOnly(dueDateValue, 'Due date');
    const reason = optionalText(reasonValue, 'Reason', 500) || 'Due date updated';
    let id;
    db.transaction(() => {
      const loan = loanOrThrow(db, loanId);
      if (loan.state === 'cancelled') throw new Error('Cancelled loans cannot be changed');
      id = loan.id;
      db.prepare("UPDATE loans SET due_date=?,updated_at=datetime('now') WHERE id=?").run(dueDate, loan.id);
      insertLoanEvent(db, loan, 'due_date_changed', {
        session,
        oldDueDate: loan.due_date,
        newDueDate: dueDate,
        reason,
      });
    })();
    return hydrateLoan(db, id);
  });

  guard(ipcMain, 'pos:loans:adjustBalance', { admin: true }, ({ session }, loanId, deltaValue, reasonValue) => {
    const rawDelta = Number(deltaValue);
    if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < 0.005) throw new Error('Adjustment must be a non-zero amount');
    const delta = round2(rawDelta);
    const reason = requiredText(reasonValue, 'Adjustment reason', 500);
    let id;
    db.transaction(() => {
      const loan = loanOrThrow(db, loanId);
      if (loan.state === 'cancelled') throw new Error('Cancelled loans cannot be adjusted');
      const next = round2(Number(loan.balance) + delta);
      if (next < 0) throw new Error('Adjustment would make the balance negative');
      id = loan.id;
      setLoanBalance(db, loan, next);
      insertLoanEvent(db, loan, 'balance_adjusted', { session, amountDelta: delta, reason });
      reconcileCustomerCredit(db, loan.customer_id);
    })();
    return hydrateLoan(db, id);
  });

  guard(ipcMain, 'pos:loans:reversePayment', { admin: true }, ({ session }, paymentIdValue, reasonValue) => {
    const paymentId = integerId(paymentIdValue, 'Payment');
    const reason = requiredText(reasonValue, 'Reversal reason', 500);
    let loanId;
    db.transaction(() => {
      const payment = db.prepare('SELECT * FROM loan_payments WHERE id=?').get(paymentId);
      if (!payment) throw new Error('Payment not found');
      if (payment.reversed_at) throw new Error('Payment has already been reversed');
      const loan = loanOrThrow(db, payment.loan_id);
      if (loan.state === 'cancelled') throw new Error('Payments on a cancelled loan cannot be reversed');
      loanId = loan.id;
      db.prepare(`UPDATE loan_payments SET reversed_at=datetime('now'),reversed_by=?,
        reversed_by_name=?,reversal_reason=? WHERE id=?`).run(
        session.id,
        session.full_name,
        reason,
        payment.id
      );
      setLoanBalance(db, loan, round2(Number(loan.balance) + Number(payment.amount)));
      insertLoanEvent(db, loan, 'payment_reversed', {
        session,
        amountDelta: Number(payment.amount),
        reason,
      });
      reconcileCustomerCredit(db, loan.customer_id);
    })();
    return hydrateLoan(db, loanId);
  });

  guard(ipcMain, 'pos:loans:reminderStatus', { auth: true }, () => {
    const enabled = ctx.getSetting(db, 'telegram_enabled') === '1';
    const configured = !!(ctx.getSetting(db, 'telegram_token') && ctx.getSetting(db, 'telegram_chat_id'));
    const lastSent = db.prepare(`SELECT sent_at FROM loan_reminders WHERE state='sent'
      ORDER BY sent_at DESC,id DESC LIMIT 1`).get();
    const lastFailure = db.prepare(`SELECT last_error,created_at FROM loan_reminders WHERE state IN ('failed','uncertain')
      ORDER BY created_at DESC,id DESC LIMIT 1`).get();
    return {
      enabled,
      configured,
      last_sent_at: lastSent ? lastSent.sent_at : null,
      last_error: lastFailure ? lastFailure.last_error : null,
      last_error_at: lastFailure ? lastFailure.created_at : null,
    };
  });

  guard(ipcMain, 'pos:loans:runReminders', { admin: true }, async () => {
    const { runLoanReminders } = require('../lib/loan-reminders');
    return runLoanReminders({ db, getSetting: ctx.getSetting });
  });
}

module.exports = { register, listCustomerSummaries, customerLoanSummary };
