'use strict';
/* Test helpers for YANKENT POS — creates a fresh temp SQLite DB (sql.js) with schema + seed. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase, ensureSettings } = require('../src/main/db');
const { seedDatabase } = require('../src/main/db/seed');

async function freshDb() {
  const p = path.join(os.tmpdir(), `yankent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = await openDatabase(p);
  ensureSettings(db);
  seedDatabase(db);
  const close = () => {
    try { db.close(); } catch {}
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + ext); } catch {} }
  };
  return { db, path: p, close };
}

module.exports = { freshDb };
