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
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', deliveryUncertain: true }); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a document (file) via the Telegram Bot API using multipart/form-data.
 * @param {string} token - bot token
 * @param {string} chatId - target chat id
 * @param {string} filename - name to show in Telegram
 * @param {Buffer} buffer - file contents
 * @param {string} [caption] - optional caption (HTML parse mode)
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function sendDocument(token, chatId, filename, buffer, caption) {
  return new Promise((resolve) => {
    if (!token || !chatId) return resolve({ ok: false, error: 'Missing token or chat ID' });
    const boundary = 'yankent-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const parts = [];
    const push = (name, value) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`));
      parts.push(Buffer.from(value + '\r\n'));
    };
    push('chat_id', String(chatId));
    if (caption) push('caption', caption);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const url = new URL(`https://api.telegram.org/bot${token}/sendDocument`);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        timeout: 60000,
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
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', deliveryUncertain: true }); });
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
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', deliveryUncertain: true }); });
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
  // 2-decimal formatting to match the in-app Reports tab (App.ui.money).
  // Whole-peso rounding caused the owner's Telegram report to disagree with
  // the cashier's on-screen totals by up to ₱0.99 per line.
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '₱' + (v < 0 ? '-' : '') + s;
}

/**
 * Escape HTML special characters in user-supplied text before inserting
 * into a Telegram message sent with parse_mode=HTML.  Product and cashier
 * names routinely contain <, >, & (e.g. "Nails & Screws", 'Angle < 90°',
 * '3/4" Pipe') — without escaping, Telegram rejects the whole message
 * with "Bad Request: can't parse entities" and the report never arrives.
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split a VAT-inclusive total into net + VAT components (for display only).
 * The DB stores VAT-inclusive totals, so derive the net component with
 * net = total / (1 + rate/100).
 */
function vatSplit(total, vatRate = 12) {
  const t = Number(total) || 0;
  const net = t / (1 + vatRate / 100);
  return { net, vat: t - net };
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

  const salesToday = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')
       AND payment_method != 'account'`
  ).get();

  const utangToday = db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')
       AND payment_method = 'account'`
  ).get();

  const avgTx = today.tx > 0 ? today.total / today.tx : 0;
  const avgTxSales = salesToday.tx > 0 ? salesToday.total / salesToday.tx : 0;

  const itemsSold = db.prepare(
    `SELECT COALESCE(SUM(si.qty),0) AS q FROM sale_items si
     JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')`
  ).get().q;

  const itemsSoldSales = db.prepare(
    `SELECT COALESCE(SUM(si.qty),0) AS q FROM sale_items si
     JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
       AND s.payment_method != 'account'`
  ).get().q;

  const topProducts = db.prepare(
    `SELECT si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total
     FROM sale_items si JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
     GROUP BY si.product_id ORDER BY total DESC LIMIT 3`
  ).all();

  const topProductsSales = db.prepare(
    `SELECT si.name, SUM(si.qty) AS qty, SUM(si.amount) AS total
     FROM sale_items si JOIN sales s ON si.sale_id=s.id
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
       AND s.payment_method != 'account'
     GROUP BY si.product_id ORDER BY total DESC LIMIT 3`
  ).all();

  const topCashier = db.prepare(
    `SELECT s.cashier_name, COUNT(*) AS tx, SUM(s.total) AS total FROM sales s
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
     GROUP BY s.cashier_id ORDER BY total DESC LIMIT 1`
  ).get();

  const topCashierSales = db.prepare(
    `SELECT s.cashier_name, COUNT(*) AS tx, SUM(s.total) AS total FROM sales s
     WHERE s.status='completed' AND date(s.datetime)=date('now','localtime')
       AND s.payment_method != 'account'
     GROUP BY s.cashier_id ORDER BY total DESC LIMIT 1`
  ).get();

  const payBreak = db.prepare(
    `SELECT payment_method, COUNT(*) AS tx, SUM(total) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')
     GROUP BY payment_method`
  ).all();

  const payBreakSales = db.prepare(
    `SELECT payment_method, COUNT(*) AS tx, SUM(total) AS total FROM sales
     WHERE status='completed' AND date(datetime)=date('now','localtime')
       AND payment_method != 'account'
     GROUP BY payment_method`
  ).all();

  return {
    today,
    salesToday,
    utangToday,
    avgTx,
    avgTxSales,
    itemsSold,
    itemsSoldSales,
    topProducts,
    topProductsSales,
    topCashier,
    topCashierSales,
    payBreak,
    payBreakSales,
  };
}

/**
 * Build the owner sales-report message string from the local database,
 * including an analytics breakdown.
 * Sales totals exclude Utang (on-account); Utang is listed separately.
 */
function buildReportMessage(db) {
  const { buildReportSummaryWithVat } = require('./report-summary');
  const summary = buildReportSummaryWithVat(db);
  const today = summary.sales.today;
  const yesterday = summary.sales.yesterday;
  const week = summary.sales.week;
  const month = summary.sales.month;
  const year = summary.sales.year;
  const utang = summary.utang;

  let bestDay = '—';
  if (summary.sales.bestDay) {
    bestDay = `${summary.sales.bestDay.label} - ${reportMoney(summary.sales.bestDay.total)}`;
  }

  const a = buildAnalytics(db);
  const lines = [
    '<b>YANKENT POS Sales Report</b>',
    '<i>Sales exclude Utang (on-account)</i>',
    '━━━━━━━━━━━━━━━━━━',
    `📅 Today: ${reportMoney(today.total)} / ${today.tx} transactions`,
    `   Net: ${reportMoney(today.net)} · VAT included: ${reportMoney(today.vat)}`,
    `📆 Yesterday: ${reportMoney(yesterday.total)} / ${yesterday.tx} transactions`,
    `🗓️ This Week: ${reportMoney(week.total)} / ${week.tx} tx`,
    `📊 This Month: ${reportMoney(month.total)} / ${month.tx} tx`,
    `   Net: ${reportMoney(month.net)} · VAT included: ${reportMoney(month.vat)}`,
    `📈 This Year: ${reportMoney(year.total)} / ${year.tx} tx`,
    `🏆 Best Day (Sales): ${bestDay}`,
    '',
    '<b>🧾 Utang (On-Account)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `Today: ${reportMoney(utang.today.total)} / ${utang.today.tx} tx`,
    `Yesterday: ${reportMoney(utang.yesterday.total)} / ${utang.yesterday.tx} tx`,
    `This Week: ${reportMoney(utang.week.total)} / ${utang.week.tx} tx`,
    `This Month: ${reportMoney(utang.month.total)} / ${utang.month.tx} tx`,
    `This Year: ${reportMoney(utang.year.total)} / ${utang.year.tx} tx`,
    '',
    '<b>📊 Analytics (Today · Sales)</b>',
    '━━━━━━━━━━━━━━━━━━',
    `Avg. Transaction: ${reportMoney(a.avgTxSales)}`,
    `Items Sold: ${Math.round(a.itemsSoldSales)}`,
  ];
  const tops = a.topProductsSales || [];
  if (tops.length) {
    lines.push('Top Products:');
    tops.forEach((p, i) => lines.push(`${i + 1}. ${escapeHtml(p.name)} — ${reportMoney(p.total)} (${Math.round(p.qty)} sold)`));
  }
  if (a.topCashierSales) {
    lines.push(`Top Cashier: ${escapeHtml(a.topCashierSales.cashier_name)} — ${reportMoney(a.topCashierSales.total)} / ${a.topCashierSales.tx} tx`);
  }
  if (a.payBreakSales.length) {
    lines.push('Payments: ' + a.payBreakSales.map((p) => `${p.payment_method} ${reportMoney(p.total)}`).join(' · '));
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

module.exports = { checkOnline, sendMessage, sendDocument, buildReportMessage, buildAnalytics, reportMoney, escapeHtml, vatSplit, callApi, sendApprovalRequest, pollUpdates, answerCallback, deleteWebhook };
