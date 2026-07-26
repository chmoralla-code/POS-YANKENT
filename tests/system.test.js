'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  bootIdFrom,
  isPathInside,
  shouldClearLegacyAutostart,
  isDatabaseCorruptionError,
} = require('../src/main/lib/system');

test('boot identifier remains stable across launches in the same OS boot', () => {
  const bootTime = Date.UTC(2026, 6, 26, 1, 2, 3);
  assert.equal(
    bootIdFrom(bootTime + 10 * 60 * 1000, 10 * 60),
    bootIdFrom(bootTime + 8 * 60 * 60 * 1000, 8 * 60 * 60)
  );
});

test('renderer path containment rejects sibling and parent paths', () => {
  const root = path.resolve('C:\\app\\renderer');
  assert.equal(isPathInside(root, path.join(root, 'js', 'app.js')), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'renderer-evil', 'index.html')), false);
  assert.equal(isPathInside(root, path.resolve(root, '..', 'secret.txt')), false);
});

test('legacy autostart cleanup only runs for the exact enabled marker', () => {
  assert.equal(shouldClearLegacyAutostart('1'), true);
  assert.equal(shouldClearLegacyAutostart(' 1 '), true);
  for (const value of ['0', '', null, undefined, false]) {
    assert.equal(shouldClearLegacyAutostart(value), false);
  }
});

test('database recovery distinguishes corruption from operational failures', () => {
  assert.equal(isDatabaseCorruptionError(new Error('database disk image is malformed')), true);
  assert.equal(isDatabaseCorruptionError(new Error('file is not a database')), true);
  assert.equal(isDatabaseCorruptionError(new Error('EACCES: permission denied')), false);
  assert.equal(isDatabaseCorruptionError(new Error('Database changes could not be saved')), false);
});
