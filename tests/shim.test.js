'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshDb } = require('./dbutil');

test('persistence failures are surfaced and latch future writes', async () => {
  const fixture = await freshDb();
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(fixture.path)) {
      const error = new Error('simulated disk failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalRename(source, destination);
  };

  try {
    assert.throws(
      () => fixture.db.prepare("UPDATE settings SET value='Changed' WHERE key='store_name'").run(),
      (error) => error.code === 'PERSISTENCE_ERROR' && /could not be saved/i.test(error.message)
    );
    assert.throws(
      () => fixture.db.prepare("UPDATE settings SET value='Again' WHERE key='store_name'").run(),
      (error) => error.code === 'PERSISTENCE_ERROR' && /cannot be saved/i.test(error.message)
    );
  } finally {
    fs.renameSync = originalRename;
    fixture.close();
  }
});

test('prepared statements stay usable after a write flushes the database', async () => {
  const fixture = await freshDb();
  try {
    // sql.js export() (run on every flush) frees all prepared statements.
    const upsert = fixture.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    const read = fixture.db.prepare('SELECT value FROM settings WHERE key=?');
    upsert.run('shim_reuse_a', '1');
    upsert.run('shim_reuse_b', '2');
    assert.strictEqual(read.get('shim_reuse_a').value, '1');
    upsert.run('shim_reuse_a', '3');
    assert.strictEqual(read.get('shim_reuse_a').value, '3');
    assert.deepStrictEqual(read.all('shim_reuse_b'), [{ value: '2' }]);
  } finally {
    fixture.close();
  }
});
