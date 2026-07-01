'use strict';

const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.allowPrerelease = false;

let checkPromise = null;

/**
 * Compare two semver-ish version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Initialize the auto-updater.
 * Call once after the main window is created to start checking in background.
 */
function initUpdater(mainWindow) {
  autoUpdater.logger = null;

  // Forward events to renderer
  autoUpdater.on('update-available', (info) => {
    mainWindow.webContents.send('pos:update:available', info);
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow.webContents.send('pos:update:not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('pos:update:download-progress', progress);
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('pos:update:downloaded');
  });

  autoUpdater.on('error', (err) => {
    mainWindow.webContents.send('pos:update:error', err.message);
  });
}

/**
 * Check for updates. Returns { available, version, releaseNotes, currentVersion }.
 * If not packaged, returns { available: false, devMode: true }.
 */
async function checkForUpdates() {
  if (!checkPromise) {
    if (!require('electron').app.isPackaged) {
      return { devMode: true, available: false, currentVersion: require('electron').app.getVersion() };
    }
    checkPromise = autoUpdater.checkForUpdates().then((result) => {
      checkPromise = null;
      const currentVersion = require('electron').app.getVersion();
      if (result && result.updateInfo) {
        const remoteVersion = result.updateInfo.version;
        // Only treat as available when the remote version is strictly newer.
        if (compareVersions(remoteVersion, currentVersion) > 0) {
          return {
            available: true,
            version: remoteVersion,
            releaseNotes: result.updateInfo.releaseNotes || '',
            currentVersion,
          };
        }
        return { available: false, currentVersion };
      }
      return { available: false, currentVersion };
    }).catch((err) => {
      checkPromise = null;
      throw err;
    });
  }
  return checkPromise;
}

/**
 * Start downloading the update in the background.
 */
function downloadUpdate() {
  autoUpdater.downloadUpdate();
}

/**
 * Quit and install the downloaded update.
 */
function installUpdate() {
  autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, installUpdate };
