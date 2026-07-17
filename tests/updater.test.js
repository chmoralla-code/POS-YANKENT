'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const updater = require('../src/main/updater');

class FakeAutoUpdater extends EventEmitter {
  constructor({ checkResult, downloadResult, downloadError, installError } = {}) {
    super();
    this.checkResult = checkResult || { isUpdateAvailable: false, updateInfo: { version: '2.0.5' } };
    this.downloadResult = downloadResult || ['YANKENT-POS-Setup.exe'];
    this.downloadError = downloadError || null;
    this.installError = installError || null;
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    this.emit('update-downloaded', { version: this.checkResult.updateInfo.version });
    return this.downloadResult;
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
    if (this.installError) this.emit('error', this.installError);
  }
}

function createHarness(options = {}) {
  const autoUpdater = new FakeAutoUpdater(options);
  const app = {
    isPackaged: true,
    getVersion: () => options.currentVersion || '2.0.5',
  };
  const sent = [];
  const window = options.window || {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, data) => sent.push([channel, data]),
    },
  };

  updater._setTestDependencies({ autoUpdater, app });
  updater.initUpdater(window, { schedule: false });
  return { autoUpdater, app, sent, window };
}

test('check respects electron-updater isUpdateAvailable=false', async () => {
  const { autoUpdater } = createHarness({
    checkResult: {
      isUpdateAvailable: false,
      // A numerically newer version must not bypass rollout/support decisions.
      updateInfo: { version: '9.0.0', releaseNotes: 'staged release' },
    },
  });

  const result = await updater.checkForUpdates();

  assert.deepEqual(result, { available: false, currentVersion: '2.0.5' });
  assert.equal(autoUpdater.checkCalls, 1);
  assert.equal(updater.getState().status, 'idle');
  assert.equal(updater.getState().availableVersion, null);
});

test('successful check, download, and install follow the state machine', async () => {
  const { autoUpdater } = createHarness({
    checkResult: {
      isUpdateAvailable: true,
      updateInfo: { version: '2.1.0', releaseNotes: 'Printer recovery improvements' },
    },
  });

  const check = await updater.checkForUpdates();
  assert.deepEqual(check, {
    available: true,
    version: '2.1.0',
    releaseNotes: 'Printer recovery improvements',
    currentVersion: '2.0.5',
  });
  assert.equal(updater.getState().status, 'available');
  assert.equal(updater.getState().availableVersion, '2.1.0');

  const download = await updater.downloadUpdate();
  assert.deepEqual(download, { downloaded: true, version: '2.1.0' });
  assert.equal(autoUpdater.downloadCalls, 1);
  assert.equal(updater.getState().status, 'downloaded');
  assert.equal(updater.getState().downloadedVersion, '2.1.0');

  assert.equal(updater.installUpdate(), true);
  assert.deepEqual(autoUpdater.installCalls, [[false, true]]);
  assert.equal(updater.getState().status, 'installing');
});

test('download rejection propagates and records the updater error', async () => {
  const failure = new Error('GitHub download interrupted');
  const { autoUpdater } = createHarness({
    checkResult: {
      isUpdateAvailable: true,
      updateInfo: { version: '2.1.0', releaseNotes: '' },
    },
    downloadError: failure,
  });

  await updater.checkForUpdates();
  await assert.rejects(updater.downloadUpdate(), failure);

  assert.equal(autoUpdater.downloadCalls, 1);
  assert.equal(updater.getState().status, 'error');
  assert.equal(updater.getState().lastError, failure.message);
});

test('synchronous installer launch errors propagate to the caller', async () => {
  const failure = new Error('Windows blocked the installer');
  createHarness({
    checkResult: {
      isUpdateAvailable: true,
      updateInfo: { version: '2.1.0', releaseNotes: '' },
    },
    installError: failure,
  });

  await updater.checkForUpdates();
  await updater.downloadUpdate();

  assert.throws(() => updater.installUpdate(), failure);
  assert.equal(updater.getState().status, 'error');
  assert.equal(updater.getState().lastError, failure.message);
});

test('install is rejected before an update has downloaded', () => {
  const { autoUpdater } = createHarness();

  assert.throws(() => updater.installUpdate(), /not downloaded yet/i);
  assert.deepEqual(autoUpdater.installCalls, []);
  assert.equal(updater.getState().status, 'idle');
});

test('updater events are safe after the target window is destroyed', () => {
  const autoUpdater = new FakeAutoUpdater();
  const app = { isPackaged: true, getVersion: () => '2.0.5' };
  let sendCalls = 0;
  const destroyedWindow = {
    isDestroyed: () => true,
    webContents: {
      isDestroyed: () => false,
      send: () => {
        sendCalls += 1;
        throw new Error('send must not be called for a destroyed window');
      },
    },
  };

  updater._setTestDependencies({ autoUpdater, app });
  updater.initUpdater(destroyedWindow, { schedule: false });

  assert.doesNotThrow(() => autoUpdater.emit('checking-for-update'));
  assert.doesNotThrow(() => autoUpdater.emit('update-available', { version: '2.1.0' }));
  assert.doesNotThrow(() => autoUpdater.emit('download-progress', { percent: 25 }));
  assert.doesNotThrow(() => autoUpdater.emit('update-downloaded', { version: '2.1.0' }));
  assert.doesNotThrow(() => autoUpdater.emit('error', new Error('late network error')));
  assert.equal(sendCalls, 0);
});
