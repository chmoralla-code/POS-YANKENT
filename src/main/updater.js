'use strict';

const AUTO_CHECK_DELAY_MS = 30 * 1000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Lazy dependencies keep this module safe to load in plain Node unit tests.
let _autoUpdater = null;
let _electronApp = null;
let mainWindowRef = null;
let initialized = false;
let checkPromise = null;
let downloadPromise = null;
let autoCheckTimer = null;
let autoCheckInterval = null;

const state = {
  status: 'idle',
  currentVersion: null,
  availableVersion: null,
  downloadedVersion: null,
  lastCheckedAt: null,
  lastError: null,
};

function app() {
  if (!_electronApp) _electronApp = require('electron').app;
  return _electronApp;
}

function autoUpdater() {
  if (!_autoUpdater) {
    _autoUpdater = require('electron-updater').autoUpdater;
  }
  _autoUpdater.autoDownload = false;
  _autoUpdater.allowPrerelease = false;
  return _autoUpdater;
}

function snapshot() {
  return { ...state };
}

function safeSend(channel, data) {
  try {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    if (!mainWindowRef.webContents || mainWindowRef.webContents.isDestroyed()) return;
    mainWindowRef.webContents.send(channel, data);
  } catch {}
}

function setState(patch) {
  Object.assign(state, patch);
  safeSend('pos:update:state', snapshot());
}

function messageOf(error) {
  return error && error.message ? error.message : String(error || 'Unknown update error');
}

function recordError(error) {
  const message = messageOf(error);
  setState({ status: 'error', lastError: message });
  return message;
}

function scheduleAutomaticChecks() {
  if (!app().isPackaged || autoCheckTimer || autoCheckInterval) return;
  const check = () => {
    checkForUpdates().catch((error) => {
      console.warn('[updater] Automatic check failed:', messageOf(error));
    });
  };
  autoCheckTimer = setTimeout(check, AUTO_CHECK_DELAY_MS);
  autoCheckInterval = setInterval(check, AUTO_CHECK_INTERVAL_MS);
  if (autoCheckTimer.unref) autoCheckTimer.unref();
  if (autoCheckInterval.unref) autoCheckInterval.unref();
}

/** Attach updater events once and begin quiet background checks for packaged clients. */
function initUpdater(mainWindow, options = {}) {
  mainWindowRef = mainWindow;
  if (initialized) return;
  initialized = true;

  const au = autoUpdater();
  au.logger = console;
  state.currentVersion = app().getVersion();

  au.on('checking-for-update', () => {
    setState({ status: 'checking', lastError: null });
  });
  au.on('update-available', (info) => {
    setState({ status: 'available', availableVersion: info && info.version || null, lastError: null });
    safeSend('pos:update:available', info);
  });
  au.on('update-not-available', () => {
    setState({ status: 'idle', availableVersion: null, lastError: null });
    safeSend('pos:update:not-available');
  });
  au.on('download-progress', (progress) => {
    setState({ status: 'downloading', lastError: null });
    safeSend('pos:update:download-progress', progress);
  });
  au.on('update-downloaded', (info) => {
    const version = info && info.version || state.availableVersion;
    setState({ status: 'downloaded', downloadedVersion: version || null, lastError: null });
    safeSend('pos:update:downloaded', info || null);
  });
  au.on('error', (error) => {
    safeSend('pos:update:error', recordError(error));
  });

  if (options.schedule !== false) scheduleAutomaticChecks();
}

/** Check GitHub Releases while respecting electron-updater rollout/support decisions. */
async function checkForUpdates() {
  const electronApp = app();
  if (!electronApp.isPackaged) {
    return { devMode: true, available: false, currentVersion: electronApp.getVersion() };
  }
  if (checkPromise) return checkPromise;

  setState({ status: 'checking', currentVersion: electronApp.getVersion(), lastError: null });
  checkPromise = (async () => {
    try {
      const result = await autoUpdater().checkForUpdates();
      const currentVersion = electronApp.getVersion();
      const checkedAt = new Date().toISOString();
      if (result && result.isUpdateAvailable === true && result.updateInfo) {
        const info = result.updateInfo;
        setState({
          status: 'available',
          currentVersion,
          availableVersion: info.version || null,
          lastCheckedAt: checkedAt,
          lastError: null,
        });
        return {
          available: true,
          version: info.version,
          releaseNotes: info.releaseNotes || '',
          currentVersion,
        };
      }
      setState({
        status: 'idle',
        currentVersion,
        availableVersion: null,
        lastCheckedAt: checkedAt,
        lastError: null,
      });
      return { available: false, currentVersion };
    } catch (error) {
      recordError(error);
      throw error;
    } finally {
      checkPromise = null;
    }
  })();
  return checkPromise;
}

/** Download only an update that electron-updater has already approved. */
async function downloadUpdate() {
  if (state.status === 'downloaded') {
    return { downloaded: true, version: state.downloadedVersion, cached: true };
  }
  if (downloadPromise) return downloadPromise;
  if (state.status !== 'available' && state.status !== 'downloading') {
    throw new Error('Check for updates before starting a download.');
  }

  setState({ status: 'downloading', lastError: null });
  downloadPromise = (async () => {
    try {
      await autoUpdater().downloadUpdate();
      if (state.status !== 'downloaded') {
        setState({ status: 'downloaded', downloadedVersion: state.availableVersion, lastError: null });
      }
      return { downloaded: true, version: state.downloadedVersion || state.availableVersion };
    } catch (error) {
      recordError(error);
      throw error;
    } finally {
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}

/** Install only after the verified download has completed. */
function installUpdate() {
  if (state.status !== 'downloaded') {
    throw new Error('The update is not downloaded yet.');
  }
  setState({ status: 'installing', lastError: null });
  autoUpdater().quitAndInstall(false, true);
  // NSIS launch failures can be emitted synchronously instead of thrown.
  if (state.status === 'error') {
    throw new Error(state.lastError || 'Could not start the update installer.');
  }
  return true;
}

function getState() {
  if (!state.currentVersion) state.currentVersion = app().getVersion();
  return snapshot();
}

// Narrow test seam; never exposed through preload/IPC.
function _setTestDependencies(dependencies) {
  _autoUpdater = dependencies.autoUpdater;
  _electronApp = dependencies.app;
  mainWindowRef = null;
  initialized = false;
  checkPromise = null;
  downloadPromise = null;
  if (autoCheckTimer) clearTimeout(autoCheckTimer);
  if (autoCheckInterval) clearInterval(autoCheckInterval);
  autoCheckTimer = null;
  autoCheckInterval = null;
  Object.assign(state, {
    status: 'idle',
    currentVersion: null,
    availableVersion: null,
    downloadedVersion: null,
    lastCheckedAt: null,
    lastError: null,
  });
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getState,
  _setTestDependencies,
};
