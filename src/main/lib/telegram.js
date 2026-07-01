'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Check whether the machine has real internet access by attempting to reach
 * multiple well-known endpoints. Returns true if any responds. Does not block
 * the UI (callers await). Telegram sending only runs when this is true;
 * the POS keeps working offline regardless.
 */
function checkOnline(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const tryHost = (host) => {
      const req = https.get(host, { timeout: timeoutMs }, (res) => { res.resume(); finish(res.statusCode > 0); });
      req.on('error', () => {});
      req.on('timeout', () => { req.destroy(); });
    };
    // Ping several endpoints; resolve true as soon as one answers.
    tryHost('https://api.telegram.org');
    tryHost('https://www.google.com');
    tryHost('https://1.1.1.1');
    // If nothing responds within the timeout, resolve false.
    setTimeout(() => finish(false), timeoutMs + 500);
  });
}

/**
 * Send a text message via the Telegram Bot API.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function sendMessage(token, chatId, text) {
  return new Promise((resolve) => {
    if (!token || !chatId) return resolve({ ok: false, error: 'Missing token or chat ID' });
    const body = JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML' });
    const url = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.ok ? { ok: true } : { ok: false, error: j.description || 'Telegram error' });
          } catch {
            resolve({ ok: false, error: 'Bad response' });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/** Generic Telegram Bot API call (POST JSON). */
function callApi(token, method, payload) {
  return new Promise((resolve) => {
    if (!token) return resolve({ ok: false, error: 'no token' });
    const body = JSON.stringify(payload || {});
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    const req = https.request(
      {
        method: 'POST', hostname: url.hostname, path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 35000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/** Send a password-reset approval request with Approve/Deny buttons. */
async function sendApprovalRequest(token, chatId, resetToken, username) {
  return callApi(token, 'sendMessage', {
    chat_id: String(chatId),
    text: `🔐 Password Reset Request\n\nUser: <b>${username}</b>\nTime: ${new Date().toLocaleString()}\n\nClick <b>Approve</b> to allow the password reset.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Approve', callback_data: `reset:approve:${resetToken}` },
      { text: '❌ Deny', callback_data: `reset:deny:${resetToken}` },
    ]] },
  });
}

/** Poll the bot for updates (callback queries from button presses). */
async function pollUpdates(token, offset, timeout) {
  return callApi(token, 'getUpdates', { offset, timeout: timeout || 5, allowed_updates: ['callback_query'] });
}

/** Acknowledge a callback query (removes the loading spinner on the button). */
async function answerCallback(token, callbackId, text) {
  return callApi(token, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

async function deleteWebhook(token) {
  return callApi(token, 'deleteWebhook', { drop_pending_updates: true });
}

function reportMoney(n) {
  return '₱' + Math.round(Number(n) || 0).toLocaleString('en-PH');
}

/**
 * Build today's analytics (used by the in-app Analytics card and the
 * enriched Telegram report).
 */
function buildAnalytics(db) {
  const today = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')`
  ).get();

  const avgTx = today.tx > 0 ? today.total / today.tx : 0;

  const itemsSold = db.prepare(
    `SELECT COALESCE(SUM(si.qty),0) AS q FROM sale_items si
     JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')`
  ).get().q;

  const topProducts = db.prepare(
    `SELECT si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total
     FROM sale_items si JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
     GROUP BY si.product_id ORDER BY total DESC LIMIT 3`
  ).all();

  const topCashier = db.prepare(
    `SELECT s.cashier_name, COUNT(*) AS tx, SUM(s.total) AS total FROM sales s
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
     GROUP BY s.cashier_id ORDER BY total DESC LIMIT 1`
  ).get();

  const payBreak = db.prepare(
    `SELECT payment_method, COUNT(*) AS tx, SUM(total) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')
     GROUP BY payment_method`
  ).all();

  return { today, avgTx, itemsSold, topProducts, topCashier, payBreak };
}

/**
 * Build the owner sales-report message string from the local database,
 * including an analytics breakdown.
 */
function buildReportMessage(db) {
  const today = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total
     FROM sales WHERE status='completed'
       AND date(datetime)=date('now','localtime')`
  ).get();

  const yesterday = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed'
       AND date(datetime)=date('now','localtime','-1 day')`
  ).get();

  const month = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales WHERE status='completed'
       AND strftime('%Y-%m', datetime)=strftime('%Y-%m','now','localtime')`
  ).get();

  const year = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales WHERE status='completed'
       AND strftime('%Y', datetime)=strftime('%Y','now','localtime')`
  ).get();

  const best = db.prepare(
    `SELECT date(datetime) AS d, SUM(total) AS total FROM sales
     WHERE status='completed' GROUP BY date(datetime) ORDER BY total DESC LIMIT 1`
  ).get();

  let bestDay = '—';
  if (best && best.d) {
    const dt = new Date(best.d + 'T00:00:00');
    bestDay = `${dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} - ${reportMoney(best.total)}`;
  }

  const a = buildAnalytics(db);
  const lines = [
    '<b>YANKENT POS Sales Report</b>',
    '━━━━━━━━━━━━━━━━━━',
    `📅 Today: ${reportMoney(today.total)} / ${today.tx} transactions`,
    `📆 Yesterday: ${reportMoney(yesterday.total)} / ${yesterday.tx} transactions`,
    `📊 This Month: ${reportMoney(month.total)} / ${month.tx} tx`,
    `📈 This Year: ${reportMoney(year.total)} / ${year.tx} tx`,
    `🏆 Best Day: ${bestDay}`,
    '',
    '<b>📊 Analytics (Today)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `Avg. Transaction: ${reportMoney(a.avgTx)}`,
    `Items Sold: ${Math.round(a.itemsSold)}`,
  ];
  if (a.topProducts.length) {
    lines.push('Top Products:');
    a.topProducts.forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${reportMoney(p.total)} (${Math.round(p.qty)} sold)`));
  }
  if (a.topCashier) {
    lines.push(`Top Cashier: ${a.topCashier.cashier_name} — ${reportMoney(a.topCashier.total)} / ${a.topCashier.tx} tx`);
  }
  if (a.payBreak.length) {
    lines.push('Payments: ' + a.payBreak.map((p) => `${p.payment_method} ${reportMoney(p.total)}`).join(' · '));
  }
  // Refunds
  try {
    const refToday = db.prepare(`SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM refunds WHERE date(datetime)=date('now','localtime')`).get();
    if (refToday && refToday.tx > 0) {
      lines.push('', '<b>↩️ Refunds (Today)</b>', '━━━━━━━━━━━━━━━━━━', `Refunds: ${refToday.tx} / ${reportMoney(refToday.total)}`);
    }
  } catch {}
  lines.push('', '<i>Sent from YANKENT POS</i>');
  return lines.join('\n');
}

module.exports = { checkOnline, sendMessage, buildReportMessage, buildAnalytics, reportMoney, callApi, sendApprovalRequest, pollUpdates, answerCallback, deleteWebhook };
