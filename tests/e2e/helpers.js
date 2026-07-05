'use strict';
/* E2E helpers — launch the Electron app with a fresh smoke DB. */
const { _electron, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const APP_MAIN = path.join(__dirname, '..', '..', 'src', 'main', 'main.js');

async function launchApp({ resetDb = true } = {}) {
  const smokeDb = path.join(process.env.TEMP || '/tmp', 'yankent-e2e.sqlite');
  if (resetDb) {
    try { fs.unlinkSync(smokeDb); } catch {}
    for (let i = 1; i <= 5; i++) {
      try { fs.unlinkSync(`${smokeDb}.${i}`); } catch {}
    }
  }
  const electron = await _electron.launch({
    args: [APP_MAIN],
    env: {
      ...process.env,
      YANKENT_SMOKE: '1',
      YANKENT_E2E: '1',
      YANKENT_DB: smokeDb,
      NODE_ENV: 'test',
    },
    cwd: path.join(__dirname, '..', '..'),
    timeout: 60000,
  });
  const page = await electron.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { electron, page };
}

async function login(page, username = 'admin', password = 'admin123') {
  // Wait for the startup splash to finish — the login form listener attaches
  // only after App._initStartup() completes (~850ms+).
  await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
  await page.waitForSelector('#loginUser:not([style*="visibility: hidden"]):not([style*="visibility:hidden"])', { state: 'visible' });
  await page.fill('#loginUser', username);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)', { state: 'visible', timeout: 30000 });
}

async function navigate(page, view) {
  await page.click(`.nav-item[data-view="${view}"]`);
  await page.waitForTimeout(300);
}

async function screenshot(page, name) {
  if (process.env.E2E_SCREENSHOTS === '1') {
    await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', `e2e-${name}.png`), fullPage: false });
  }
}

module.exports = { launchApp, login, navigate, screenshot, expect };
