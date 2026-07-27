'use strict';

const { checkOnline, reportMoney } = require('./telegram');
const { sendEmail } = require('./resend');
const { localDateISO, dayDifference } = require('./loans');

const SENDER_NAME = 'YANKENT CONSTRUCTION';
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 12 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 16 * 1000;
const DELIVERY_UNCERTAIN_ERROR = 'Email delivery status is unknown because the app shut down during the send';
let activeRun = null;
let activeDelivery = null;
let shutdownRequested = false;
const unpersistedDeliveries = new Set();

function sanitizeError(value, apiKey) {
  let text = String(value || 'Email reminder failed');
  if (apiKey) text = text.split(String(apiKey)).join('[redacted]');
  return text.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function emailRows(db, loanId = null) {
  const idFilter = loanId == null ? '' : ' AND l.id=?';
  const stmt = db.prepare(`SELECT l.*,c.name AS customer_name,c.entity_kind,c.contact_person,
      c.phone,c.email,c.email_reminder_enabled,c.email_reminder_days,
      s.txn_id,s.datetime AS sale_datetime
    FROM loans l
    JOIN customers c ON c.id=l.customer_id
    LEFT JOIN sales s ON s.id=l.sale_id
    WHERE l.state='open' AND l.balance>0 AND l.due_date IS NOT NULL
      AND c.email_reminder_enabled=1 AND TRIM(COALESCE(c.email,''))!=''${idFilter}
    ORDER BY l.due_date,l.id`);
  return loanId == null ? stmt.all() : stmt.all(loanId);
}

function eligibleSnapshot(row, today) {
  try {
    const daysToDue = dayDifference(today, row.due_date);
    const reminderDays = Number(row.email_reminder_days);
    if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 365) return null;
    if (!validEmail(row.email)) return null;
    return daysToDue >= 0 && daysToDue <= reminderDays
      ? { ...row, days_to_due: daysToDue, email_reminder_days: reminderDays }
      : null;
  } catch (error) {
    console.error(`[loan-email-reminders] Skipped ${row.loan_number || row.id}: ${sanitizeError(error && error.message)}`);
    return null;
  }
}

function eligibleEmailLoans(db, today = localDateISO()) {
  return emailRows(db).map((row) => eligibleSnapshot(row, today)).filter(Boolean);
}

function eligibleEmailLoan(db, loanId, today) {
  const row = emailRows(db, loanId)[0];
  return row ? eligibleSnapshot(row, today) : null;
}

function itemSummary(db, loan, limit = 12) {
  if (!loan.sale_id) return [{ label: 'Legacy opening balance', amount: null }];
  const rows = db.prepare(`SELECT name,qty,unit,amount FROM sale_items
    WHERE sale_id=? ORDER BY id LIMIT ?`).all(loan.sale_id, limit + 1);
  const visible = rows.slice(0, limit).map((item) => ({
    label: `${Number(item.qty)} ${item.unit} ${item.name}`,
    amount: Number(item.amount || 0),
  }));
  if (rows.length > limit) {
    visible.push({ label: `And ${rows.length - limit} more item(s)`, amount: null });
  }
  return visible.length ? visible : [{ label: 'No item details', amount: null }];
}

function displayDueDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) return String(value || '');
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildLoanReminderEmail(db, loan, settings = {}) {
  const paidRow = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM loan_payments
    WHERE loan_id=? AND reversed_at IS NULL`).get(loan.id);
  const amountPaid = Number(paidRow ? paidRow.total : 0) || 0;
  const items = itemSummary(db, loan);
  const due = displayDueDate(loan.due_date);
  const timing = loan.days_to_due === 0
    ? 'due today'
    : `due in ${loan.days_to_due} day${loan.days_to_due === 1 ? '' : 's'}`;
  const greeting = String(loan.contact_person || loan.customer_name || 'Customer').trim();
  const senderEmail = String(settings.resend_from_email || '').trim();
  const storePhone = String(settings.store_phone || '').trim();
  const from = `${SENDER_NAME} <${senderEmail}>`;
  const subject = `Payment reminder: ${loan.loan_number} is ${timing}`;
  const itemRows = items.map((item) => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e5e5">${escapeHtml(item.label)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e5e5e5;text-align:right;white-space:nowrap">${item.amount == null ? '' : escapeHtml(reportMoney(item.amount))}</td>
  </tr>`).join('');
  const contactLine = storePhone
    ? ` If you have already paid or need help, please contact us at ${escapeHtml(storePhone)}.`
    : ' If you have already paid or need help, please contact YANKENT CONSTRUCTION.';
  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f4f4;color:#171717;font-family:Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:24px 14px">
    <div style="background:#171717;color:#fff;padding:18px 22px;font-weight:700;letter-spacing:.04em">${SENDER_NAME}</div>
    <div style="background:#fff;padding:24px 22px;border:1px solid #dedede">
      <h1 style="font-size:22px;margin:0 0 16px">Utang payment reminder</h1>
      <p>Hello ${escapeHtml(greeting)},</p>
      <p>This is a friendly reminder that your outstanding balance of <strong>${escapeHtml(reportMoney(loan.balance))}</strong> is ${escapeHtml(timing)} on <strong>${escapeHtml(due)}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fafafa">
        <tr><td style="padding:8px 10px"><strong>Loan</strong></td><td style="padding:8px 10px;text-align:right">${escapeHtml(loan.loan_number)}</td></tr>
        <tr><td style="padding:8px 10px"><strong>Sale</strong></td><td style="padding:8px 10px;text-align:right">${escapeHtml(loan.txn_id || 'Legacy Balance')}</td></tr>
        <tr><td style="padding:8px 10px"><strong>Original amount</strong></td><td style="padding:8px 10px;text-align:right">${escapeHtml(reportMoney(loan.principal))}</td></tr>
        <tr><td style="padding:8px 10px"><strong>Payments received</strong></td><td style="padding:8px 10px;text-align:right">${escapeHtml(reportMoney(amountPaid))}</td></tr>
      </table>
      <h2 style="font-size:16px;margin:22px 0 8px">Purchased items</h2>
      <table style="width:100%;border-collapse:collapse">${itemRows}</table>
      <p style="margin-top:22px">${contactLine}</p>
      <p>Thank you,<br><strong>${SENDER_NAME}</strong></p>
    </div>
  </div>
</body></html>`;
  const textItems = items.map((item) =>
    `- ${item.label}${item.amount == null ? '' : ` — ${reportMoney(item.amount)}`}`
  ).join('\n');
  const text = [
    SENDER_NAME,
    '',
    `Hello ${greeting},`,
    '',
    `This is a friendly reminder that your outstanding balance of ${reportMoney(loan.balance)} is ${timing} on ${due}.`,
    `Loan: ${loan.loan_number}`,
    `Sale: ${loan.txn_id || 'Legacy Balance'}`,
    `Original amount: ${reportMoney(loan.principal)}`,
    `Payments received: ${reportMoney(amountPaid)}`,
    '',
    'Purchased items:',
    textItems,
    '',
    storePhone
      ? `If you have already paid or need help, please contact us at ${storePhone}.`
      : 'If you have already paid or need help, please contact YANKENT CONSTRUCTION.',
    '',
    `Thank you,\n${SENDER_NAME}`,
  ].join('\n');
  return {
    from,
    to: loan.email,
    subject,
    html,
    text,
    idempotencyKey: `yankent-utang-${loan.id}-${loan.due_date}`,
  };
}

function reminderRow(db, loanId, dueDate) {
  return db.prepare('SELECT * FROM loan_email_reminders WHERE loan_id=? AND due_date=?')
    .get(loanId, dueDate);
}

function isTerminalReminderState(state) {
  return state === 'sent' || state === 'uncertain';
}

function ensureReminderStatePersisted(delivery, expectedState) {
  const stored = delivery.db.prepare('SELECT * FROM loan_email_reminders WHERE id=?').get(delivery.rowId);
  if (!stored || stored.state !== expectedState) {
    throw new Error(`Could not verify email reminder state '${expectedState}'`);
  }
  if (typeof delivery.db.flush === 'function') delivery.db.flush();
  return stored;
}

function persistDeliveryUncertain(delivery, reason, interrupted = false) {
  delivery.outcome = 'uncertain';
  delivery.uncertainReason = reason;
  if (interrupted) delivery.interruptionRequested = true;
  delivery.statePersisted = false;
  unpersistedDeliveries.add(delivery);
  try {
    delivery.db.prepare(`UPDATE loan_email_reminders SET state='uncertain',last_error=?
      WHERE id=? AND state!='sent'`).run(reason, delivery.rowId);
    const stored = delivery.db.prepare('SELECT state FROM loan_email_reminders WHERE id=?').get(delivery.rowId);
    const terminalState = stored && stored.state === 'sent' ? 'sent' : 'uncertain';
    ensureReminderStatePersisted(delivery, terminalState);
    delivery.outcome = terminalState;
    delivery.statePersisted = true;
    delivery.persistenceError = null;
    unpersistedDeliveries.delete(delivery);
    if (delivery.interruptionRequested) delivery.interrupted = true;
    return true;
  } catch (error) {
    delivery.persistenceError = sanitizeError(error && error.message);
    console.error('[loan-email-reminders] Could not persist uncertain delivery state:', delivery.persistenceError);
    return false;
  }
}

function retryUnpersistedDelivery(delivery) {
  if (!delivery || delivery.statePersisted) {
    if (delivery) unpersistedDeliveries.delete(delivery);
    return true;
  }
  if (delivery.outcome === 'sent') {
    try {
      delivery.db.prepare(`UPDATE loan_email_reminders SET state='sent',last_error=NULL,
        resend_email_id=COALESCE(?,resend_email_id),sent_at=COALESCE(sent_at,datetime('now'))
        WHERE id=?`).run(delivery.messageId || null, delivery.rowId);
      ensureReminderStatePersisted(delivery, 'sent');
      delivery.statePersisted = true;
      delivery.persistenceError = null;
      unpersistedDeliveries.delete(delivery);
      return true;
    } catch (error) {
      delivery.persistenceError = sanitizeError(error && error.message);
      return false;
    }
  }
  return persistDeliveryUncertain(
    delivery,
    delivery.uncertainReason || DELIVERY_UNCERTAIN_ERROR,
    delivery.interruptionRequested
  );
}

function retryUnpersistedForDb(db) {
  for (const delivery of [...unpersistedDeliveries]) {
    if (delivery.db === db) retryUnpersistedDelivery(delivery);
  }
  return ![...unpersistedDeliveries].some((delivery) => delivery.db === db);
}

function markActiveDeliveryUncertain() {
  return activeDelivery
    ? persistDeliveryUncertain(activeDelivery, DELIVERY_UNCERTAIN_ERROR, true)
    : true;
}

function drainActiveRun(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  const run = activeRun;
  if (!run) return Promise.resolve({ drained: true, timedOut: false });
  const boundedTimeout = Number(timeoutMs) >= 0 ? Number(timeoutMs) : DEFAULT_DRAIN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ drained: false, timedOut: true }), boundedTimeout);
    Promise.resolve(run).then(
      () => finish({ drained: true, timedOut: false }),
      () => finish({ drained: true, timedOut: false })
    );
  });
}

async function executeRun({
  db,
  getSetting,
  now = new Date(),
  checkOnlineFn = checkOnline,
  sendEmailFn = sendEmail,
}) {
  const today = localDateISO(now);
  const result = { date: today, eligible: 0, sent: 0, failed: 0, skipped: 0, reason: null };
  if (shutdownRequested) {
    result.reason = 'Application is shutting down';
    return result;
  }
  if (getSetting(db, 'email_reminders_enabled') !== '1') {
    result.reason = 'Customer email reminders are disabled';
    return result;
  }
  const apiKey = String(getSetting(db, 'resend_api_key') || '').trim();
  const fromEmail = String(getSetting(db, 'resend_from_email') || '').trim();
  if (!apiKey || !validEmail(fromEmail)) {
    result.reason = 'Resend email is not configured';
    return result;
  }

  const loans = eligibleEmailLoans(db, today);
  result.eligible = loans.length;
  if (!loans.length) return result;

  const online = await checkOnlineFn();
  if (shutdownRequested) {
    result.reason = 'Application is shutting down';
    result.skipped = loans.length;
    return result;
  }
  if (!online) {
    result.reason = 'Offline';
    result.skipped = loans.length;
    return result;
  }

  for (let index = 0; index < loans.length; index++) {
    if (shutdownRequested) {
      result.reason = 'Application is shutting down';
      result.skipped += loans.length - index;
      break;
    }
    const candidate = loans[index];
    let loan = candidate;
    let delivery = null;
    try {
      const currentEnabled = getSetting(db, 'email_reminders_enabled') === '1';
      const currentApiKey = String(getSetting(db, 'resend_api_key') || '').trim();
      const currentFromEmail = String(getSetting(db, 'resend_from_email') || '').trim();
      if (!currentEnabled || currentApiKey !== apiKey || currentFromEmail !== fromEmail) {
        result.reason = currentEnabled
          ? 'Email settings changed; reminder check stopped'
          : 'Customer email reminders were disabled';
        result.skipped += loans.length - index;
        break;
      }

      loan = eligibleEmailLoan(db, candidate.id, today);
      if (!loan) {
        result.skipped++;
        continue;
      }
      const existing = reminderRow(db, loan.id, loan.due_date);
      if (existing && isTerminalReminderState(existing.state)) {
        result.skipped++;
        continue;
      }
      db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO loan_email_reminders(
          loan_id,due_date,lead_days,recipient_email,state,attempt_count,last_error
        ) VALUES(?,?,?,?,'pending',0,NULL)`).run(
          loan.id,
          loan.due_date,
          loan.email_reminder_days,
          loan.email
        );
        db.prepare(`UPDATE loan_email_reminders SET state='pending',
          lead_days=?,recipient_email=?,attempt_count=attempt_count+1,last_error=NULL
          WHERE loan_id=? AND due_date=? AND state NOT IN ('sent','uncertain')`).run(
          loan.email_reminder_days,
          loan.email,
          loan.id,
          loan.due_date
        );
      })();
      const reserved = reminderRow(db, loan.id, loan.due_date);
      if (!reserved || isTerminalReminderState(reserved.state)) {
        result.skipped++;
        continue;
      }

      const message = buildLoanReminderEmail(db, loan, {
        resend_from_email: fromEmail,
        store_phone: getSetting(db, 'store_phone'),
      });
      delivery = {
        db,
        rowId: reserved.id,
        loanId: loan.id,
        dueDate: loan.due_date,
        interrupted: false,
        interruptionRequested: false,
        statePersisted: false,
        outcome: 'sending',
        messageId: null,
      };
      activeDelivery = delivery;
      const response = await sendEmailFn(apiKey, message);
      if (response && response.ok) {
        delivery.outcome = 'sent';
        delivery.messageId = response.id || null;
        unpersistedDeliveries.add(delivery);
        db.prepare(`UPDATE loan_email_reminders SET state='sent',last_error=NULL,
          resend_email_id=?,sent_at=datetime('now') WHERE id=?`)
          .run(delivery.messageId, delivery.rowId);
        ensureReminderStatePersisted(delivery, 'sent');
        delivery.statePersisted = true;
        unpersistedDeliveries.delete(delivery);
        result.sent++;
      } else if (delivery.interrupted) {
        result.skipped++;
      } else if (response && response.deliveryUncertain) {
        const reason = `Email delivery uncertain: ${sanitizeError(response.error, apiKey)}`;
        if (!persistDeliveryUncertain(delivery, reason)) {
          throw new Error('Could not persist uncertain email delivery');
        }
        result.skipped++;
      } else {
        const error = sanitizeError(response && response.error, apiKey);
        delivery.outcome = 'failed';
        db.prepare(`UPDATE loan_email_reminders SET state='failed',last_error=?
          WHERE id=?`).run(error, delivery.rowId);
        ensureReminderStatePersisted(delivery, 'failed');
        delivery.statePersisted = true;
        unpersistedDeliveries.delete(delivery);
        result.failed++;
      }
    } catch (error) {
      const safeError = sanitizeError(error && error.message, apiKey);
      if (delivery && delivery.interrupted) {
        if (!delivery.statePersisted) {
          delivery.persistenceError = safeError;
          unpersistedDeliveries.add(delivery);
          result.failed++;
        } else {
          result.skipped++;
        }
      } else if (delivery && (delivery.outcome === 'sent' || delivery.outcome === 'uncertain')) {
        delivery.statePersisted = false;
        delivery.persistenceError = safeError;
        unpersistedDeliveries.add(delivery);
        result.failed++;
      } else {
        try {
          db.prepare(`INSERT INTO loan_email_reminders(
            loan_id,due_date,lead_days,recipient_email,state,attempt_count,last_error
          ) VALUES(?,?,?,?,'failed',1,?)
          ON CONFLICT(loan_id,due_date) DO UPDATE SET
            state=CASE WHEN state IN ('sent','uncertain') THEN state ELSE 'failed' END,
            last_error=CASE WHEN state IN ('sent','uncertain') THEN last_error ELSE excluded.last_error END`)
            .run(
              loan.id,
              loan.due_date,
              loan.email_reminder_days,
              loan.email,
              safeError
            );
        } catch {}
        result.failed++;
      }
      console.error(`[loan-email-reminders] ${loan.loan_number || loan.id}: ${safeError}`);
    } finally {
      if (activeDelivery === delivery) activeDelivery = null;
    }
  }
  return result;
}

function runLoanEmailReminders(options) {
  if (activeRun) return activeRun;
  activeRun = executeRun(options).finally(() => { activeRun = null; });
  return activeRun;
}

function isLoanEmailReminderRunActive() {
  return !!activeRun;
}

function assertLoanEmailReminderRunIdle(action = 'perform this operation') {
  if (isLoanEmailReminderRunActive()) {
    throw new Error(`Cannot ${action} while customer email reminders are being sent. Try again in a moment.`);
  }
}

function startLoanEmailReminderScheduler(options) {
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  const startupDelayMs = Number(options.startupDelayMs) >= 0
    ? Number(options.startupDelayMs)
    : DEFAULT_STARTUP_DELAY_MS;
  let stopped = false;
  let stopPromise = null;
  let stopDelivery = null;
  shutdownRequested = false;
  const run = () => {
    if (stopped) return Promise.resolve(null);
    return runLoanEmailReminders(options).catch((error) => {
      console.error('[loan-email-reminders] Scheduler failed:', error && error.message ? error.message : error);
      return null;
    });
  };
  const startupTimer = setTimeout(run, startupDelayMs);
  const intervalTimer = setInterval(run, intervalMs);
  return {
    run,
    stop(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
      if (!stopPromise) {
        stopped = true;
        shutdownRequested = true;
        clearTimeout(startupTimer);
        clearInterval(intervalTimer);
        retryUnpersistedForDb(options.db);
        stopDelivery = activeDelivery;
        markActiveDeliveryUncertain();
        stopPromise = drainActiveRun(timeoutMs);
      }
      return stopPromise.then((drain) => {
        const durable = retryUnpersistedForDb(options.db);
        return {
          ...drain,
          safeToClose: durable && (!stopDelivery || stopDelivery.statePersisted),
        };
      });
    },
  };
}

module.exports = {
  SENDER_NAME,
  DEFAULT_INTERVAL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  eligibleEmailLoans,
  buildLoanReminderEmail,
  runLoanEmailReminders,
  isLoanEmailReminderRunActive,
  assertLoanEmailReminderRunIdle,
  startLoanEmailReminderScheduler,
};
