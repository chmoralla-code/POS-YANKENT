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

function reportMoney(n) {
  return '₱' + Math.round(Number(n) || 0).toLocaleString('en-PH');
}

/**
 * Build the owner sales-report message string from the local database.
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
    `SELECT COALESCE(SUM(total),0) AS total FROM sales WHERE status='completed'
       AND strftime('%Y-%m', datetime)=strftime('%Y-%m','now','localtime')`
  ).get();

  const year = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS total FROM sales WHERE status='completed'
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

  return [
    'YANKENT POS Sales Report',
    `Today: ${reportMoney(today.total)} / ${today.tx} transactions`,
    `Yesterday: ${reportMoney(yesterday.total)} / ${yesterday.tx} transactions`,
    `This Month: ${reportMoney(month.total)}`,
    `This Year: ${reportMoney(year.total)}`,
    `Best Day: ${bestDay}`,
  ].join('\n');
}

module.exports = { checkOnline, sendMessage, buildReportMessage, reportMoney };
