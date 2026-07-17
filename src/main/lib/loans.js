'use strict';

const { round2 } = require('./money');

const PAYMENT_METHODS = new Set(['cash', 'card', 'ewallet', 'bank', 'other']);
const ENTITY_KINDS = new Set(['individual', 'company']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function integerId(value, label = 'ID') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} is invalid`);
  return id;
}

function requiredText(value, label, max = 160) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return text;
}

function optionalText(value, label, max = 500) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return text;
}

function nonNegativeMoney(value, label, fallback) {
  const raw = (value === '' || value == null) && fallback !== undefined ? fallback : value;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a non-negative amount`);
  return round2(amount);
}

function positiveMoney(value, label = 'Amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${label} must be greater than zero`);
  return round2(amount);
}

function localDateISO(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateOnly(value, label = 'Date', { required = true } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (!text && !required) return null;
  if (!DATE_RE.test(text)) throw new Error(`${label} must use YYYY-MM-DD format`);
  const [year, month, day] = text.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid date`);
  }
  return text;
}

function dayDifference(fromDate, toDate) {
  const from = parseDateOnly(fromDate, 'Start date');
  const to = parseDateOnly(toDate, 'End date');
  const toUtc = (date) => {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

function validateNewDueDate(value) {
  const dueDate = parseDateOnly(value, 'Due date');
  if (dayDifference(localDateISO(), dueDate) < 0) {
    throw new Error('Due date cannot be earlier than today');
  }
  return dueDate;
}

function deriveLoanStatus(loan, today = localDateISO()) {
  const balance = round2(Number(loan && loan.balance) || 0);
  const state = String((loan && loan.state) || 'open');
  if (state === 'cancelled') return { key: 'cancelled', label: 'Cancelled', days: null };
  if (state === 'paid' || balance <= 0) return { key: 'paid', label: 'Paid', days: null };
  if (!loan.due_date) return { key: 'needs_due_date', label: 'Due Date Required', days: null };
  let days;
  try { days = dayDifference(today, loan.due_date); } catch { return { key: 'invalid_due_date', label: 'Invalid Due Date', days: null }; }
  if (days < 0) return { key: 'overdue', label: `Overdue ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, days };
  if (days === 0) return { key: 'due_today', label: 'Due Today', days: 0 };
  if (days <= 15) return { key: 'due_soon', label: `Due in ${days} day${days === 1 ? '' : 's'}`, days };
  return { key: 'open', label: 'Open', days };
}

function validateProfile(input = {}) {
  const entityKind = String(input.entity_kind || input.entityKind || 'individual').trim().toLowerCase();
  if (!ENTITY_KINDS.has(entityKind)) throw new Error('Customer type must be individual or company');
  const name = requiredText(input.name, entityKind === 'company' ? 'Company name' : 'Customer name', 160);
  const contactPerson = optionalText(input.contact_person ?? input.contactPerson, 'Contact person', 160);
  if (entityKind === 'company' && !contactPerson) throw new Error('Contact person is required for a company');
  const phone = optionalText(input.phone, 'Phone', 60);
  const email = optionalText(input.email, 'Email', 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email address is invalid');
  const address = optionalText(input.address, 'Address', 500);
  const notes = optionalText(input.notes, 'Notes', 1500);
  const creditLimit = nonNegativeMoney(input.credit_limit ?? input.creditLimit, 'Credit limit', 0);
  return {
    name,
    type: 'contractor',
    entity_kind: entityKind,
    contact_person: contactPerson,
    phone,
    email,
    address,
    notes,
    credit_limit: creditLimit,
  };
}

function normalizeCustomer(row) {
  if (!row) return null;
  const customer = { ...row };
  customer.active = customer.active === undefined ? true : !!Number(customer.active);
  customer.credit_limit = round2(customer.credit_limit);
  customer.credit_used = round2(customer.credit_used);
  customer.available_credit = round2(Math.max(0, customer.credit_limit - customer.credit_used));
  return customer;
}

function insertLoanEvent(db, loan, eventType, data = {}) {
  const actor = data.session || {};
  db.prepare(`INSERT INTO loan_events(
    loan_id, customer_id, event_type, amount_delta, old_due_date, new_due_date,
    reason, actor_id, actor_name
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    loan.id,
    loan.customer_id,
    eventType,
    data.amountDelta == null ? null : round2(data.amountDelta),
    data.oldDueDate || null,
    data.newDueDate || null,
    data.reason ? optionalText(data.reason, 'Reason', 1000) : null,
    actor.id || null,
    actor.full_name || actor.name || null
  );
}

function createLoanRecord(db, input = {}) {
  const customerId = integerId(input.customerId, 'Customer');
  const principal = nonNegativeMoney(input.principal, 'Loan principal');
  const dueDate = parseDateOnly(input.dueDate, 'Due date', { required: input.source !== 'legacy' });
  const source = String(input.source || 'sale');
  if (!['sale', 'legacy', 'adjustment'].includes(source)) throw new Error('Invalid loan source');
  const saleId = input.saleId == null ? null : integerId(input.saleId, 'Sale');
  const session = input.session || {};
  const temporaryNumber = `PENDING-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initialState = principal > 0 ? 'open' : 'paid';
  const info = db.prepare(`INSERT INTO loans(
    loan_number, customer_id, sale_id, source, principal, balance, due_date,
    state, note, created_by, created_by_name, paid_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    temporaryNumber,
    customerId,
    saleId,
    source,
    principal,
    principal,
    dueDate,
    initialState,
    optionalText(input.note, 'Loan note', 1000) || null,
    session.id || null,
    session.full_name || session.name || null,
    initialState === 'paid' ? new Date().toISOString() : null
  );
  const id = Number(info.lastInsertRowid);
  const loanNumber = 'UT-' + String(id).padStart(6, '0');
  db.prepare('UPDATE loans SET loan_number=? WHERE id=?').run(loanNumber, id);
  const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(id);
  insertLoanEvent(db, loan, source === 'legacy' ? 'legacy_created' : 'created', {
    session,
    amountDelta: principal,
    reason: source === 'legacy' ? (input.note || 'Opening balance migrated from the previous credit total') : input.note,
  });
  return loan;
}

function createSaleLoan(db, sale, session) {
  if (!sale || sale.payment_method !== 'account') return null;
  const existing = db.prepare('SELECT * FROM loans WHERE sale_id=?').get(sale.id);
  if (existing) return existing;
  if (!sale.customer_id) throw new Error('On-account sale is missing its customer');
  const dueDate = parseDateOnly(sale.due_date, 'Due date');
  return createLoanRecord(db, {
    customerId: sale.customer_id,
    saleId: sale.id,
    source: 'sale',
    principal: sale.total,
    dueDate,
    note: `On-Account sale ${sale.txn_id}`,
    session,
  });
}

function reconcileCustomerCredit(db, customerId) {
  const id = integerId(customerId, 'Customer');
  const row = db.prepare(`SELECT COALESCE(SUM(balance),0) AS total
    FROM loans WHERE customer_id=? AND state='open' AND balance>0`).get(id);
  const total = round2(row ? row.total : 0);
  db.prepare('UPDATE customers SET credit_used=?, updated_at=datetime(\'now\') WHERE id=?').run(total, id);
  return total;
}

function reconcileAllCustomerCredit(db) {
  const customers = db.prepare('SELECT id FROM customers').all();
  for (const customer of customers) reconcileCustomerCredit(db, customer.id);
  return customers.length;
}

function migrateLegacyBalances(db) {
  const customers = db.prepare(`SELECT c.* FROM customers c
    WHERE COALESCE(c.credit_used,0)>0
      AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.customer_id=c.id)`).all();
  let created = 0;
  const run = db.transaction(() => {
    for (const customer of customers) {
      createLoanRecord(db, {
        customerId: customer.id,
        source: 'legacy',
        principal: customer.credit_used,
        dueDate: null,
        note: 'Legacy opening balance — administrator must assign a due date',
      });
      reconcileCustomerCredit(db, customer.id);
      created++;
    }
  });
  run();
  return created;
}

function preserveImportedCreditDifferences(db, { transactional = true } = {}) {
  const customers = db.prepare('SELECT id, credit_used FROM customers').all();
  let created = 0;
  const run = () => {
    for (const customer of customers) {
      const expected = nonNegativeMoney(customer.credit_used, 'Imported credit balance', 0);
      const row = db.prepare(`SELECT COALESCE(SUM(balance),0) AS total FROM loans
        WHERE customer_id=? AND state='open' AND balance>0`).get(customer.id);
      const ledger = round2(row ? row.total : 0);
      const difference = round2(expected - ledger);
      if (difference > 0.009) {
        createLoanRecord(db, {
          customerId: customer.id,
          source: 'legacy',
          principal: difference,
          dueDate: null,
          note: 'Imported balance difference preserved for administrator review',
        });
        created++;
      }
      reconcileCustomerCredit(db, customer.id);
    }
  };
  if (transactional) db.transaction(run)();
  else run();
  return created;
}

function hydrateLoan(db, loanOrId) {
  const loan = typeof loanOrId === 'object' && loanOrId
    ? { ...loanOrId }
    : db.prepare('SELECT * FROM loans WHERE id=?').get(integerId(loanOrId, 'Loan'));
  if (!loan) return null;
  const customer = db.prepare(`SELECT id,name,type,entity_kind,contact_person,phone,email,address,notes,
    credit_limit,credit_used,active,created_at,updated_at FROM customers WHERE id=?`).get(loan.customer_id);
  const sale = loan.sale_id
    ? db.prepare('SELECT id,txn_id,datetime,status,total,payment_method,due_date FROM sales WHERE id=?').get(loan.sale_id)
    : null;
  const items = loan.sale_id
    ? db.prepare(`SELECT id,product_id,sku,name,unit,qty,unit_price,amount,line_type
        FROM sale_items WHERE sale_id=? ORDER BY id`).all(loan.sale_id)
    : [];
  const payments = db.prepare(`SELECT * FROM loan_payments WHERE loan_id=? ORDER BY paid_at DESC,id DESC`).all(loan.id);
  const events = db.prepare(`SELECT * FROM loan_events WHERE loan_id=? ORDER BY created_at DESC,id DESC`).all(loan.id);
  const paid = payments
    .filter((payment) => !payment.reversed_at)
    .reduce((sum, payment) => round2(sum + Number(payment.amount || 0)), 0);
  const status = deriveLoanStatus(loan);
  return {
    ...loan,
    principal: round2(loan.principal),
    balance: round2(loan.balance),
    amount_paid: paid,
    status: status.key,
    status_label: status.label,
    days_to_due: status.days,
    customer: normalizeCustomer(customer),
    sale,
    items,
    payments,
    events,
  };
}

function setLoanBalance(db, loan, balance) {
  const next = round2(balance);
  if (next < 0) throw new Error('Loan balance cannot be negative');
  if (loan.state === 'cancelled') throw new Error('Cancelled loans cannot be changed');
  const state = next <= 0 ? 'paid' : 'open';
  db.prepare(`UPDATE loans SET balance=?, state=?, updated_at=datetime('now'),
    paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at,datetime('now')) ELSE NULL END
    WHERE id=?`).run(next, state, state, loan.id);
  return { ...loan, balance: next, state };
}

function cancelSaleLoan(db, saleId, session, reason) {
  const id = integerId(saleId, 'Sale');
  const sale = db.prepare('SELECT id,txn_id,customer_id,total,payment_method FROM sales WHERE id=?').get(id);
  const loan = db.prepare('SELECT * FROM loans WHERE sale_id=?').get(id);
  if (loan) {
    if (loan.state === 'cancelled') return loan;
    const cleared = round2(loan.balance);
    db.prepare(`UPDATE loans SET balance=0,state='cancelled',cancelled_at=datetime('now'),
      updated_at=datetime('now') WHERE id=?`).run(loan.id);
    insertLoanEvent(db, loan, 'sale_refunded', {
      session,
      amountDelta: -cleared,
      reason: reason || 'Linked On-Account sale refunded',
    });
    reconcileCustomerCredit(db, loan.customer_id);
    return db.prepare('SELECT * FROM loans WHERE id=?').get(loan.id);
  }

  // Pre-feature account sales are represented by an aggregate Legacy Balance
  // rather than one Loan per historical sale. Preserve the old refund behavior
  // by reducing those opening balances without inventing a sale link.
  if (!sale || sale.payment_method !== 'account' || !sale.customer_id) return null;
  let remaining = round2(sale.total);
  const legacyLoans = db.prepare(`SELECT * FROM loans WHERE customer_id=? AND source='legacy'
    AND state='open' AND balance>0 ORDER BY id`).all(sale.customer_id);
  let last = null;
  for (const legacy of legacyLoans) {
    if (remaining <= 0) break;
    const reduction = round2(Math.min(Number(legacy.balance), remaining));
    last = setLoanBalance(db, legacy, round2(Number(legacy.balance) - reduction));
    insertLoanEvent(db, legacy, 'sale_refunded', {
      session,
      amountDelta: -reduction,
      reason: reason || `Historical On-Account sale ${sale.txn_id} refunded`,
    });
    remaining = round2(remaining - reduction);
  }
  reconcileCustomerCredit(db, sale.customer_id);
  return last;
}

module.exports = {
  PAYMENT_METHODS,
  ENTITY_KINDS,
  integerId,
  requiredText,
  optionalText,
  nonNegativeMoney,
  positiveMoney,
  localDateISO,
  parseDateOnly,
  dayDifference,
  validateNewDueDate,
  deriveLoanStatus,
  validateProfile,
  normalizeCustomer,
  insertLoanEvent,
  createLoanRecord,
  createSaleLoan,
  reconcileCustomerCredit,
  reconcileAllCustomerCredit,
  migrateLegacyBalances,
  preserveImportedCreditDifferences,
  hydrateLoan,
  setLoanBalance,
  cancelSaleLoan,
};
