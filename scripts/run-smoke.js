'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `yankent-smoke-${process.pid}-${Date.now()}.sqlite`);
const profilePath = path.join(os.tmpdir(), `yankent-smoke-profile-${process.pid}-${Date.now()}`);
const electronPath = require('electron');

const result = spawnSync(electronPath, [`--user-data-dir=${profilePath}`, '.'], {
  cwd: root,
  env: { ...process.env, YANKENT_SMOKE: '1', YANKENT_DB: dbPath },
  stdio: 'inherit',
  windowsHide: true,
});

for (const suffix of ['', '-wal', '-shm', '.tmp']) {
  try { fs.unlinkSync(dbPath + suffix); } catch {}
}
try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch {}

if (result.error) {
  console.error('[smoke] failed to launch Electron:', result.error.message);
  process.exit(1);
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
