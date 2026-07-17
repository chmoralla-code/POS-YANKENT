'use strict';

const { checkOnline, sendMessage, escapeHtml, reportMoney } = require('./telegram');
const { localDateISO, dayDifference } = require('./loans');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 10 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 16 * 1000;
const DELIVERY_UNCERTAIN_ERROR = 'Telegram delivery status is unknown because the app shut down during the send';
let activeRun = null;
let activeDelivery = null;
let shutdownRequested = false;
const unpersistedDeliveries = new Set();

function sanitizeError(value, token) {
  let text = String(value || 'Telegram reminder failed');
  if (token) text = text.split(String(token)).join('[redacted]');
  return text.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function loanRows(db, loanId = null) {
  const idFilter = loanId == null ? '' : ' AND l.id=?';
  const stmt = db.prepare(`SELECT l.*,c.name AS customer_name,c.entity_kind,c.contact_person,
      c.phone,c.email,s.txn_id,s.datetime AS sale_datetime
    FROM loans l
    JOIN customers c ON c.id=l.customer_id
    LEFT JOIN sales s ON s.id=l.sale_id
    WHERE l.state='open' AND l.balance>0 AND l.due_date IS NOT NULL${idFilter}
    ORDER BY l.due_date,l.id`);
  return loanId == null ? stmt.all() : stmt.all(loanId);
}

function eligibleSnapshot(row, today) {
  try {
    const snapshot = { ...row, days_to_due: dayDifference(today, row.due_date) };
    return snapshot.days_to_due <= 15 ? snapshot : null;
  } catch (error) {
    console.error(`[loan-reminders] Skipped ${row.loan_number || row.id}: ${sanitizeError(error && error.message)}`);
    return null;
  }
}

function eligibleLoans(db, today = localDateISO()) {
  return loanRows(db).map((row) => eligibleSnapshot(row, today)).filter(Boolean);
}

function eligibleLoan(db, loanId, today) {
  const row = loanRows(db, loanId)[0];
  return row ? eligibleSnapshot(row, today) : null;
}

function itemSummary(db, loan, limit = 8) {
  if (!loan.sale_id) return ['Legacy opening balance'];
  const items = db.prepare(`SELECT name,qty,unit FROM sale_items
    WHERE sale_id=? ORDER BY id LIMIT ?`).all(loan.sale_id, limit + 1);
  const visible = items.slice(0, limit).map((item) =>
    `${Number(item.qty)} ${escapeHtml(item.unit)} ${escapeHtml(item.name)}`
  );
  if (items.length > limit) visible.push(`and ${items.length - limit} more item(s)`);
  return visible.length ? visible : ['No item details'];
}

function buildLoanReminderMessage(db, loan) {
  const paidRow = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM loan_payments
    WHERE loan_id=? AND reversed_at IS NULL`).get(loan.id);
  const amountPaid = Number(paidRow ? paidRow.total : 0) || 0;
  const timing = loan.days_to_due < 0
    ? `Overdue by ${Math.abs(loan.days_to_due)} day${Math.abs(loan.days_to_due) === 1 ? '' : 's'}`
    : loan.days_to_due === 0
      ? 'Due today'
      : `Due in ${loan.days_to_due} day${loan.days_to_due === 1 ? '' : 's'}`;
  const contact = [loan.contact_person, loan.phone, loan.email]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map(escapeHtml)
    .join(' | ') || 'No contact details';
  const items = itemSummary(db, loan).map((line) => `- ${line}`).join('\n');
  const lines = [
    '<b>YANKENT POS Utang Reminder</b>',
    '--------------------',
    `<b>${escapeHtml(loan.customer_name)}</b>${loan.entity_kind === 'company' ? ' (Company)' : ''}`,
    `Contact: ${contact}`,
    `Loan: ${escapeHtml(loan.loan_number)}`,
    `Sale: ${escapeHtml(loan.txn_id || 'Legacy Balance')}`,
    `Due date: ${escapeHtml(loan.due_date)} (${timing})`,
    `Principal: ${reportMoney(loan.principal)}`,
    `Paid: ${reportMoney(amountPaid)}`,
    `<b>Outstanding: ${reportMoney(loan.balance)}</b>`,
    '',
    '<b>Purchased items</b>',
    items,
  ];
  // Telegram limits messages to 4096 characters. Keep a safety margin for
  // escaped entities and any future fixed labels.
  return lines.join('\n').slice(0, 3900);
}

function reminderRow(db, loanId, reminderDate) {
  return db.prepare('SELECT * FROM loan_reminders WHERE loan_id=? AND reminder_date=?')
    .get(loanId, reminderDate);
}

function isTerminalReminderState(state) {
  return state === 'sent' || state === 'uncertain';
}

function ensureReminderStatePersisted(db, loanId, reminderDate, expectedState) {
  const stored = reminderRow(db, loanId, reminderDate);
  if (!stored || stored.state !== expectedState) {
    throw new Error(`Could not verify Telegram reminder state '${expectedState}'`);
  }
  // Normal writes remain failure-tolerant for offline POS operation, but a
  // post-send idempotency marker must surface disk errors before shutdown.
  if (typeof db.flush === 'function') db.flush();
  return stored;
}

function persistDeliveryUncertain(delivery, reason, interrupted = false) {
  delivery.outcome = 'uncertain';
  delivery.uncertainReason = reason;
  if (interrupted) delivery.interruptionRequested = true;
  delivery.statePersisted = false;
  unpersistedDeliveries.add(delivery);
  try {
    delivery.db.prepare(`UPDATE loan_reminders SET state='uncertain',last_error=?
      WHERE loan_id=? AND reminder_date=? AND state!='sent'`)
      .run(reason, delivery.loanId, delivery.reminderDate);
    const stored = reminderRow(delivery.db, delivery.loanId, delivery.reminderDate);
    const terminalState = stored && stored.state === 'sent' ? 'sent' : 'uncertain';
    ensureReminderStatePersisted(delivery.db, delivery.loanId, delivery.reminderDate, terminalState);
    delivery.outcome = terminalState;
    delivery.statePersisted = true;
    delivery.persistenceError = null;
    unpersistedDeliveries.delete(delivery);
    if (delivery.interruptionRequested) delivery.interrupted = true;
    return true;
  } catch (error) {
    delivery.statePersisted = false;
    delivery.persistenceError = sanitizeError(error && error.message);
    unpersistedDeliveries.add(delivery);
    console.error('[loan-reminders] Could not persist uncertain delivery state:', delivery.persistenceError);
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
      delivery.db.prepare(`UPDATE loan_reminders SET state='sent',last_error=NULL,
        telegram_message_id=COALESCE(?,telegram_message_id),sent_at=COALESCE(sent_at,datetime('now'))
        WHERE loan_id=? AND reminder_date=?`)
        .run(delivery.messageId || null, delivery.loanId, delivery.reminderDate);
      ensureReminderStatePersisted(delivery.db, delivery.loanId, delivery.reminderDate, 'sent');
      delivery.statePersisted = true;
      delivery.persistenceError = null;
      unpersistedDeliveries.delete(delivery);
      return true;
    } catch (error) {
      delivery.persistenceError = sanitizeError(error && error.message);
      unpersistedDeliveries.add(delivery);
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
  const delivery = activeDelivery;
  if (!delivery) return true;
  return persistDeliveryUncertain(delivery, DELIVERY_UNCERTAIN_ERROR, true);
}

function isAmbiguousDeliveryFailure(response) {
  if (response && response.deliveryUncertain) return true;
  const error = String(response && response.error || '').toLowerCase();
  return error === 'timeout' || error.includes('timed out');
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
  sendMessageFn = sendMessage,
}) {
  const today = localDateISO(now);
  const result = { date: today, eligible: 0, sent: 0, failed: 0, skipped: 0, reason: null };
  if (shutdownRequested) {
    result.reason = 'Application is shutting down';
    return result;
  }
  if (getSetting(db, 'telegram_enabled') !== '1') {
    result.reason = 'Telegram reminders are disabled';
    return result;
  }
  const token = getSetting(db, 'telegram_token');
  const chatId = getSetting(db, 'telegram_chat_id');
  if (!token || !chatId) {
    result.reason = 'Telegram is not configured';
    return result;
  }

  const loans = eligibleLoans(db, today);
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
      // Settings may change while connectivity or an earlier Telegram send is
      // awaiting the network. Never continue with a disabled or stale chat.
      const currentEnabled = getSetting(db, 'telegram_enabled') === '1';
      const currentToken = getSetting(db, 'telegram_token');
      const currentChatId = getSetting(db, 'telegram_chat_id');
      if (!currentEnabled || currentToken !== token || currentChatId !== chatId) {
        result.reason = currentEnabled
          ? 'Telegram settings changed; reminder check stopped'
          : 'Telegram reminders were disabled';
        result.skipped += loans.length - index;
        break;
      }

      // Network detection yields to the event loop. Re-read immediately before
      // reserving/sending so a payment, refund, due-date change, or deactivation
      // that happened while checking connectivity cannot use a stale snapshot.
      loan = eligibleLoan(db, candidate.id, today);
      if (!loan) {
        result.skipped++;
        continue;
      }

      const unpersisted = [...unpersistedDeliveries].find((delivery) =>
        delivery.db === db && delivery.loanId === loan.id && delivery.reminderDate === today
      );
      if (unpersisted) {
        retryUnpersistedDelivery(unpersisted);
        result.skipped++;
        continue;
      }

      const existing = reminderRow(db, loan.id, today);
      if (existing && isTerminalReminderState(existing.state)) {
        result.skipped++;
        continue;
      }
      db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO loan_reminders(
          loan_id,reminder_date,state,attempt_count,last_error
        ) VALUES(?,?,'pending',0,NULL)`).run(loan.id, today);
        db.prepare(`UPDATE loan_reminders SET state='pending',attempt_count=attempt_count+1,
          last_error=NULL WHERE loan_id=? AND reminder_date=? AND state NOT IN ('sent','uncertain')`).run(loan.id, today);
      })();
      const reserved = reminderRow(db, loan.id, today);
      if (!reserved || isTerminalReminderState(reserved.state)) {
        result.skipped++;
        continue;
      }

      const message = buildLoanReminderMessage(db, loan);
      delivery = {
        db,
        loanId: loan.id,
        reminderDate: today,
        interrupted: false,
        interruptionRequested: false,
        statePersisted: false,
        outcome: 'sending',
        messageId: null,
      };
      activeDelivery = delivery;
      const response = await sendMessageFn(token, chatId, message);
      if (response && response.ok) {
        // A confirmed Telegram response resolves a shutdown-time uncertainty
        // while the DB is still open during the bounded drain.
        delivery.outcome = 'sent';
        delivery.messageId = response.messageId || null;
        delivery.statePersisted = false;
        unpersistedDeliveries.add(delivery);
        db.prepare(`UPDATE loan_reminders SET state='sent',last_error=NULL,
          telegram_message_id=?,sent_at=datetime('now') WHERE loan_id=? AND reminder_date=?`)
          .run(delivery.messageId, loan.id, today);
        ensureReminderStatePersisted(db, loan.id, today, 'sent');
        delivery.statePersisted = true;
        unpersistedDeliveries.delete(delivery);
        result.sent++;
      } else if (delivery.interrupted) {
        // stop() already persisted state='uncertain'. It is terminal for this
        // Loan/day because retrying could duplicate a message Telegram received.
        result.skipped++;
      } else if (isAmbiguousDeliveryFailure(response)) {
        const error = sanitizeError(response && response.error, token);
        const uncertainError = `Telegram delivery uncertain: ${error}`;
        if (!persistDeliveryUncertain(delivery, uncertainError)) {
          throw new Error('Could not persist uncertain Telegram delivery');
        }
        result.skipped++;
      } else {
        const error = sanitizeError(response && response.error, token);
        delivery.outcome = 'failed';
        db.prepare(`UPDATE loan_reminders SET state='failed',last_error=?
          WHERE loan_id=? AND reminder_date=?`).run(error, loan.id, today);
        ensureReminderStatePersisted(db, loan.id, today, 'failed');
        delivery.statePersisted = true;
        unpersistedDeliveries.delete(delivery);
        result.failed++;
      }
    } catch (error) {
      const safeError = sanitizeError(error && error.message, token);
      if (delivery && delivery.interrupted) {
        // If a later uncertain→sent rewrite failed during the drain, the
        // earlier marker can no longer be assumed durable because sql.js
        // rewrites the whole file. Keep shutdown blocked until it is flushed.
        if (!delivery.statePersisted) {
          delivery.persistenceError = safeError;
          unpersistedDeliveries.add(delivery);
          result.failed++;
        } else {
          result.skipped++;
        }
        console.error(`[loan-reminders] ${loan.loan_number || loan.id}: ${safeError}`);
      } else if (delivery && (delivery.outcome === 'sent' || delivery.outcome === 'uncertain')) {
        // Never downgrade a known/ambiguous delivery to retryable 'failed'.
        // Keep an in-memory terminal marker and retry only its durable write.
        delivery.statePersisted = false;
        delivery.persistenceError = safeError;
        unpersistedDeliveries.add(delivery);
        result.failed++;
        console.error(`[loan-reminders] ${loan.loan_number || loan.id}: ${safeError}`);
      } else {
        try {
          // Reservation already increments attempt_count. If an exception occurs
          // after that point, preserve the count instead of counting one network
          // attempt twice. If no row was reserved, initialize it at one.
          db.prepare(`INSERT INTO loan_reminders(loan_id,reminder_date,state,attempt_count,last_error)
            VALUES(?,?,'failed',1,?)
            ON CONFLICT(loan_id,reminder_date) DO UPDATE SET
              state=CASE WHEN state IN ('sent','uncertain') THEN state ELSE 'failed' END,
              last_error=CASE WHEN state IN ('sent','uncertain') THEN last_error ELSE excluded.last_error END`)
            .run(loan.id, today, safeError);
        } catch {}
        result.failed++;
        console.error(`[loan-reminders] ${loan.loan_number || loan.id}: ${safeError}`);
      }
    } finally {
      if (activeDelivery === delivery) activeDelivery = null;
    }
  }
  return result;
}

function runLoanReminders(options) {
  if (activeRun) return activeRun;
  activeRun = executeRun(options).finally(() => { activeRun = null; });
  return activeRun;
}

function isLoanReminderRunActive() {
  return !!activeRun;
}

function assertLoanReminderRunIdle(action = 'perform this operation') {
  if (isLoanReminderRunActive()) {
    throw new Error(`Cannot ${action} while Telegram loan reminders are being sent. Try again in a moment.`);
  }
}

function startLoanReminderScheduler(options) {
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
    return runLoanReminders(options).catch((error) => {
      console.error('[loan-reminders] Scheduler failed:', error && error.message ? error.message : error);
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
  DEFAULT_INTERVAL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  eligibleLoans,
  buildLoanReminderMessage,
  runLoanReminders,
  isLoanReminderRunActive,
  assertLoanReminderRunIdle,
  startLoanReminderScheduler,
};
