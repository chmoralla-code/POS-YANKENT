'use strict';
/**
 * better-sqlite3-compatible shim over sql.js (pure WebAssembly SQLite).
 *
 * Why: the target Windows laptop has no C++ build tools and Node 24 has no
 * prebuilt better-sqlite3 binary. sql.js is pure WASM — no native compilation,
 * works identically in Node and Electron. The shim exposes the small subset
 * of the better-sqlite3 API the app uses (.prepare/.run/.get/.all/.exec/
 * .transaction/.pragma/.close) so the rest of the codebase is unchanged.
 *
 * Persistence: the in-memory database is flushed to the .sqlite file after
 * every write (and once per committed transaction).
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let _SQL = null;
async function getSql() {
  if (_SQL) return _SQL;
  const locateFile = (f) => {
    try { return require.resolve('sql.js/dist/' + f); }
    catch { return path.resolve(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', f); }
  };
  _SQL = await initSqlJs({ locateFile });
  return _SQL;
}

class Statement {
  constructor(db, sql) { this.db = db; this.stmt = db._raw.prepare(sql); }
  _bind(args) { this.stmt.reset(); this.stmt.bind(args); }
  run(...args) {
    this._bind(args);
    this.stmt.step();
    const changes = this.db._raw.getRowsModified();
    const lastId = this._lastId();
    this.db._markDirty();
    return { changes, lastInsertRowid: lastId };
  }
  _lastId() {
    const r = this.db._raw.exec('SELECT last_insert_rowid() AS id');
    return r && r[0] && r[0].values && r[0].values[0] ? r[0].values[0][0] : 0;
  }
  get(...args) {
    this._bind(args);
    const row = this.stmt.step() ? this.stmt.getAsObject() : null;
    return row || null;
  }
  all(...args) {
    const rows = [];
    this._bind(args);
    while (this.stmt.step()) rows.push(this.stmt.getAsObject());
    return rows;
  }
}

class Database {
  constructor(raw, filePath) { this._raw = raw; this.filePath = filePath; this._inTx = 0; }
  exec(sql) { this._raw.exec(sql); this._markDirty(); }
  prepare(sql) { return new Statement(this, sql); }
  run(sql, params) { this._raw.run(sql, params); this._markDirty(); return this; }
  pragma() { /* no-op: sql.js ignores WAL; FK enforcement not required by the app */ }
  transaction(fn) {
    const self = this;
    return function (...args) {
      self._raw.run('BEGIN');
      self._inTx++;
      try {
        const r = fn.apply(this, args);
        self._raw.run('COMMIT');
        self._inTx--;
        self._flush();
        return r;
      } catch (e) {
        self._inTx--;
        try { self._raw.run('ROLLBACK'); } catch {}
        throw e;
      }
    };
  }
  _markDirty() { if (this._inTx === 0) this._flush(); }
  _flush() {
    if (!this.filePath) return;
    try { fs.writeFileSync(this.filePath, Buffer.from(this._raw.export())); } catch {}
  }
  close() { try { this._flush(); } catch {} try { this._raw.close(); } catch {} }
  getRowsModified() { return this._raw.getRowsModified(); }
}

async function openShim(filePath) {
  const SQL = await getSql();
  const dir = filePath ? path.dirname(filePath) : null;
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let raw;
  if (filePath && fs.existsSync(filePath)) raw = new SQL.Database(fs.readFileSync(filePath));
  else raw = new SQL.Database();
  return new Database(raw, filePath);
}

module.exports = { openShim, getSql, Database };
