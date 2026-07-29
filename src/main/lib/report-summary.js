'use strict';

/**
 * Period sales summary with optional Utang (on-account) separation.
 * - combined: all completed sales (legacy totals)
 * - sales: paid methods only (cash / card / ewallet) — excludes payment_method='account'
 * - utang: on-account sales only
 */

function emptyBucket() {
  return { tx: 0, total: 0 };
}

function queryBucket(db, dateSql, paymentFilterSql = '') {
  return db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed' AND ${dateSql}${paymentFilterSql}`
  ).get() || emptyBucket();
}

function queryBucketWithVat(db, dateSql, paymentFilterSql = '') {
  return db.prepare(
    `SELECT COUNT(*) AS tx, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(subtotal),0) AS net, COALESCE(SUM(vat),0) AS vat
     FROM sales
     WHERE status='completed' AND ${dateSql}${paymentFilterSql}`
  ).get() || { tx: 0, total: 0, net: 0, vat: 0 };
}

const DATE_SQL = Object.freeze({
  today: `date(datetime)=date('now','localtime')`,
  yesterday: `date(datetime)=date('now','localtime','-1 day')`,
  week: `date(datetime) >= date('now','localtime','-' || ((CAST(strftime('%w','now','localtime') AS INTEGER) + 6) % 7) || ' days')
         AND date(datetime) <= date('now','localtime')`,
  month: `strftime('%Y-%m',datetime)=strftime('%Y-%m','now','localtime')`,
  year: `strftime('%Y',datetime)=strftime('%Y','now','localtime')`,
});

const PAID_ONLY = ` AND payment_method != 'account'`;
const UTANG_ONLY = ` AND payment_method = 'account'`;
const SEPARATE_UTANG_SETTING = 'separate_utang_reports';

function getUtangSeparation(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?')
    .get(SEPARATE_UTANG_SETTING);
  const value = row == null ? '' : String(row.value);
  return {
    enabled: value === '1',
    configured: value === '0' || value === '1',
  };
}

function setUtangSeparation(db, enabled) {
  const normalized = enabled === true || enabled === 1 || enabled === '1';
  db.prepare(
    `INSERT INTO settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(SEPARATE_UTANG_SETTING, normalized ? '1' : '0');
  return { enabled: normalized, configured: true };
}

function isUtangSeparated(db) {
  return getUtangSeparation(db).enabled;
}

function reportPaymentFilter(db, column = 'payment_method') {
  if (column !== 'payment_method' && column !== 's.payment_method') {
    throw new Error('Invalid report payment column');
  }
  return isUtangSeparated(db) ? ` AND ${column} != 'account'` : '';
}

function bestDay(db, paymentFilterSql = '') {
  const best = db.prepare(
    `SELECT date(datetime) AS d, COALESCE(SUM(total),0) AS total FROM sales
     WHERE status='completed'${paymentFilterSql}
     GROUP BY date(datetime) ORDER BY total DESC LIMIT 1`
  ).get();
  if (!best || !best.d) return null;
  const dt = new Date(best.d + 'T00:00:00');
  return {
    date: best.d,
    label: dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    total: best.total,
  };
}

function periodSet(db, paymentFilterSql = '', { withVat = false } = {}) {
  const q = withVat ? queryBucketWithVat : queryBucket;
  return {
    today: q(db, DATE_SQL.today, paymentFilterSql),
    yesterday: q(db, DATE_SQL.yesterday, paymentFilterSql),
    week: q(db, DATE_SQL.week, paymentFilterSql),
    month: q(db, DATE_SQL.month, paymentFilterSql),
    year: q(db, DATE_SQL.year, paymentFilterSql),
  };
}

/**
 * @returns {{
 *   today, yesterday, week, month, year, bestDay,
 *   combined: { today, yesterday, week, month, year, bestDay },
 *   sales: { today, yesterday, week, month, year, bestDay },
 *   utang: { today, yesterday, week, month, year },
 *   separateUtang: boolean
 * }}
 */
function buildReportSummary(db) {
  const combined = periodSet(db, '');
  const sales = periodSet(db, PAID_ONLY);
  const utang = periodSet(db, UTANG_ONLY);
  const combinedWithBest = {
    ...combined,
    bestDay: bestDay(db, ''),
  };
  const salesWithBest = {
    ...sales,
    bestDay: bestDay(db, PAID_ONLY),
  };
  const separateUtang = isUtangSeparated(db);
  const selected = separateUtang ? salesWithBest : combinedWithBest;
  return {
    ...selected,
    combined: combinedWithBest,
    sales: salesWithBest,
    utang,
    separateUtang,
  };
}

/**
 * VAT-aware period buckets for Telegram (combined / sales / utang).
 */
function buildReportSummaryWithVat(db) {
  const combined = periodSet(db, '', { withVat: true });
  const sales = periodSet(db, PAID_ONLY, { withVat: true });
  const utang = periodSet(db, UTANG_ONLY, { withVat: true });
  const combinedWithBest = {
    ...combined,
    bestDay: bestDay(db, ''),
  };
  const salesWithBest = {
    ...sales,
    bestDay: bestDay(db, PAID_ONLY),
  };
  const separateUtang = isUtangSeparated(db);
  const selected = separateUtang ? salesWithBest : combinedWithBest;
  return {
    ...selected,
    combined: combinedWithBest,
    sales: salesWithBest,
    utang,
    separateUtang,
  };
}

module.exports = {
  buildReportSummary,
  buildReportSummaryWithVat,
  getUtangSeparation,
  setUtangSeparation,
  isUtangSeparated,
  reportPaymentFilter,
  DATE_SQL,
  PAID_ONLY,
  UTANG_ONLY,
  SEPARATE_UTANG_SETTING,
};
