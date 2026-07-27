'use strict';

const https = require('https');

const RESEND_HOST = 'api.resend.com';
const RESEND_PATH = '/emails';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 3;
const MIN_REQUEST_SPACING_MS = 550;
let nextRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeApiError(value) {
  return String(value || 'Resend email request failed')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response && response.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 5000);
  }
  return Math.min(500 * (2 ** attempt), 4000);
}

function shouldRetry(response) {
  const status = Number(response && response.status);
  return status === 429 || status >= 500;
}

async function waitForRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_SPACING_MS;
  if (waitMs) await sleep(waitMs);
}

function requestEmail(apiKey, payload, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  httpsModule = https,
  idempotencyKey = '',
} = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    let settled = false;
    let responseStarted = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = httpsModule.request({
      hostname: RESEND_HOST,
      path: RESEND_PATH,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'YANKENT-POS/2',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
    }, (response) => {
      responseStarted = true;
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (raw.length < 32768) raw += chunk;
      });
      response.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        const status = Number(response.statusCode || 0);
        if (status >= 200 && status < 300 && data.id) {
          finish({ ok: true, id: String(data.id), status });
          return;
        }
        const error = data.message || data.error || `Resend returned HTTP ${status || 'error'}`;
        finish({
          ok: false,
          status,
          error: sanitizeApiError(error),
          retryAfter: response.headers && response.headers['retry-after'],
          deliveryUncertain: false,
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish({
        ok: false,
        error: 'Resend request timed out',
        deliveryUncertain: true,
      });
    });
    request.on('error', (error) => {
      const definitelyUnsent = new Set([
        'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
      ]).has(error && error.code);
      finish({
        ok: false,
        error: sanitizeApiError(error && error.message),
        // Once a request has been written, a connection failure may occur
        // after Resend accepted it. The scheduler persists an uncertain state
        // instead of risking a duplicate customer email.
        deliveryUncertain: responseStarted || !definitelyUnsent,
      });
    });
    request.write(body);
    request.end();
  });
}

async function sendEmail(apiKey, input, options = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'Resend API key is missing', deliveryUncertain: false };
  const payload = {
    from: input.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };

  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await waitForRateLimit();
    last = await requestEmail(key, payload, {
      ...options,
      idempotencyKey: input.idempotencyKey,
    });
    if (last.ok || last.deliveryUncertain || !shouldRetry(last) || attempt === MAX_ATTEMPTS - 1) {
      return last;
    }
    await sleep(retryDelay(last, attempt));
  }
  return last || { ok: false, error: 'Resend email request failed', deliveryUncertain: false };
}

module.exports = {
  RESEND_HOST,
  DEFAULT_TIMEOUT_MS,
  sanitizeApiError,
  requestEmail,
  sendEmail,
};
