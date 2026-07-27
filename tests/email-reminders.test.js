'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { freshDb } = require('./dbutil');
const { makeApi } = require('./ipc-harness');
const { createSession } = require('../src/main/lib/auth');
const { setSetting, getSetting } = require('../src/main/db');
const { createLoanRecord, validateProfile } = require('../src/main/lib/loans');
const {
  SENDER_NAME,
  eligibleEmailLoans,
  buildLoanReminderEmail,
  runLoanEmailReminders,
} = require('../src/main/lib/loan-email-reminders');
const { requestEmail } = require('../src/main/lib/resend');

function addReminderLoan(db, {
  name = 'Reminder Customer',
  email = 'client@example.com',
  enabled = 1,
  days = 15,
  dueDate = '2026-08-15',
  principal = 1260,
} = {}) {
  const customerId = Number(db.prepare(`INSERT INTO customers(
    name,type,entity_kind,email,email_reminder_enabled,email_reminder_days,
    credit_limit,credit_used,active
  ) VALUES(?,?,?,?,?,?,50000,0,1)`).run(
    name,
    'contractor',
    'individual',
    email,
    enabled,
    days
  ).lastInsertRowid);
  const loan = createLoanRecord(db, {
    customerId,
    source: 'adjustment',
    principal,
    dueDate,
    note: 'Email reminder test balance',
  });
  return { customerId, loan };
}

function configureEmail(db) {
  setSetting(db, 'email_reminders_enabled', '1');
  setSetting(db, 'resend_api_key', 're_test_key');
  setSetting(db, 'resend_from_email', 'reminders@example.com');
  setSetting(db, 'telegram_enabled', '0');
}

test('customer profile validates per-customer email reminder choices', () => {
  const profile = validateProfile({
    name: 'HNU School',
    entity_kind: 'company',
    contact_person: 'Brian Ambojot',
    email: 'billing@example.com',
    email_reminder_enabled: true,
    email_reminder_days: 21,
    credit_limit: 10000,
  });
  assert.equal(profile.email_reminder_enabled, true);
  assert.equal(profile.email_reminder_days, 21);
  assert.throws(() => validateProfile({
    name: 'No Email',
    email_reminder_enabled: true,
    email_reminder_days: 15,
  }), /Email address is required/);
  assert.throws(() => validateProfile({
    name: 'Invalid Duration',
    email: 'client@example.com',
    email_reminder_enabled: true,
    email_reminder_days: 0,
  }), /between 1 and 365/);
});

test('customer create/update IPC persists reminder preference and duration', async () => {
  const api = await makeApi();
  const admin = api.db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const session = createSession(admin);
  const created = await api.call('pos:loans:createCustomer', session, {
    name: 'Email Client',
    email: 'email-client@example.com',
    email_reminder_enabled: true,
    email_reminder_days: 12,
    credit_limit: 5000,
  });
  assert.equal(created.email_reminder_enabled, true);
  assert.equal(created.email_reminder_days, 12);

  const updated = await api.call('pos:loans:updateCustomer', session, created.id, {
    ...created,
    email: '',
    email_reminder_enabled: false,
    email_reminder_days: 30,
  });
  assert.equal(updated.email_reminder_enabled, false);
  assert.equal(updated.email_reminder_days, 30);
  api.close();
});

test('eligible email loans honor each customer toggle and lead time', async () => {
  const { db, close } = await freshDb();
  addReminderLoan(db, { name: 'Eligible', days: 15, dueDate: '2026-08-15' });
  addReminderLoan(db, { name: 'Too Early', days: 7, dueDate: '2026-08-15' });
  addReminderLoan(db, { name: 'Disabled', enabled: 0, days: 30, dueDate: '2026-08-15' });
  addReminderLoan(db, { name: 'Overdue', days: 30, dueDate: '2026-07-30' });
  const rows = eligibleEmailLoans(db, '2026-07-31');
  assert.deepEqual(rows.map((row) => row.customer_name), ['Eligible']);
  assert.equal(rows[0].days_to_due, 15);
  close();
});

test('loan email uses exact sender name and escapes customer/item content', async () => {
  const { db, close } = await freshDb();
  const { loan } = addReminderLoan(db, {
    name: '<Client & Co>',
    email: 'client@example.com',
  });
  const row = eligibleEmailLoans(db, '2026-07-31').find((entry) => entry.id === loan.id);
  const email = buildLoanReminderEmail(db, row, {
    resend_from_email: 'reminders@example.com',
    store_phone: '0917 000 0000',
  });
  assert.equal(email.from, `${SENDER_NAME} <reminders@example.com>`);
  assert.equal(email.to, 'client@example.com');
  assert.match(email.subject, /UT-\d{6}/);
  assert.match(email.html, /&lt;Client &amp; Co&gt;/);
  assert.doesNotMatch(email.html, /<Client & Co>/);
  assert.match(email.html, /Legacy opening balance/);
  assert.match(email.text, /0917 000 0000/);
  close();
});

test('email scheduler sends once per loan due date and records Resend id', async () => {
  const { db, close } = await freshDb();
  configureEmail(db);
  const { loan } = addReminderLoan(db);
  const sent = [];
  const options = {
    db,
    getSetting,
    now: new Date(2026, 6, 31, 9, 0, 0),
    checkOnlineFn: async () => true,
    sendEmailFn: async (apiKey, message) => {
      sent.push({ apiKey, message });
      return { ok: true, id: 'email_123' };
    },
  };
  const first = await runLoanEmailReminders(options);
  const second = await runLoanEmailReminders(options);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiKey, 're_test_key');
  assert.equal(sent[0].message.idempotencyKey, `yankent-utang-${loan.id}-2026-08-15`);
  const stored = db.prepare('SELECT * FROM loan_email_reminders WHERE loan_id=?').get(loan.id);
  assert.equal(stored.state, 'sent');
  assert.equal(stored.resend_email_id, 'email_123');
  assert.equal(stored.recipient_email, 'client@example.com');
  close();
});

test('uncertain email delivery is terminal and API key is redacted', async () => {
  const { db, close } = await freshDb();
  configureEmail(db);
  const { loan } = addReminderLoan(db);
  let attempts = 0;
  const options = {
    db,
    getSetting,
    now: new Date(2026, 6, 31, 9, 0, 0),
    checkOnlineFn: async () => true,
    sendEmailFn: async () => {
      attempts++;
      return {
        ok: false,
        error: 'timeout while using re_test_key',
        deliveryUncertain: true,
      };
    },
  };
  const first = await runLoanEmailReminders(options);
  const second = await runLoanEmailReminders(options);
  assert.equal(first.skipped, 1);
  assert.equal(second.skipped, 1);
  assert.equal(attempts, 1);
  const stored = db.prepare('SELECT * FROM loan_email_reminders WHERE loan_id=?').get(loan.id);
  assert.equal(stored.state, 'uncertain');
  assert.doesNotMatch(stored.last_error, /re_test_key/);
  assert.match(stored.last_error, /\[redacted\]/);
  close();
});

test('Resend client sends idempotency key as a header, not in JSON', async () => {
  let capturedOptions;
  let capturedBody = '';
  const httpsModule = {
    request(options, callback) {
      capturedOptions = options;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.write = (chunk) => { capturedBody += String(chunk); };
      request.destroy = () => {};
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.setEncoding = () => {};
        callback(response);
        process.nextTick(() => {
          response.emit('data', '{"id":"email_test"}');
          response.emit('end');
        });
      };
      return request;
    },
  };
  const result = await requestEmail('re_secret', {
    from: 'YANKENT CONSTRUCTION <reminders@example.com>',
    to: ['client@example.com'],
    subject: 'Reminder',
    html: '<p>Reminder</p>',
    text: 'Reminder',
  }, {
    httpsModule,
    idempotencyKey: 'yankent-utang-1-2026-08-15',
  });
  assert.equal(result.ok, true);
  assert.equal(capturedOptions.headers['Idempotency-Key'], 'yankent-utang-1-2026-08-15');
  assert.equal(JSON.parse(capturedBody).idempotency_key, undefined);
});
