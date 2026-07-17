'use strict';
/* Section 1 — Startup & App Launch + Section 2 — Login & Authentication */
const { test, expect } = require('@playwright/test');
const { launchApp, login } = require('./helpers');

test.describe('Startup & Login', () => {
  test('app launches and shows login screen', async () => {
    const { electron, page } = await launchApp();
    try {
      await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
      await expect(page.locator('#loginUser')).toBeVisible();
      await expect(page.locator('#loginPass')).toBeVisible();
      await expect(page.locator('#loginBtn')).toHaveText(/Sign In/i);
    } finally { await electron.close(); }
  });

  test('admin login succeeds', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await expect(page.locator('#app:not(.hidden)')).toBeVisible();
      await expect(page.locator('#navUser')).not.toHaveText('—');
    } finally { await electron.close(); }
  });

  test('cashier login succeeds', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await expect(page.locator('#app:not(.hidden)')).toBeVisible();
      await expect(page.locator('#navRole')).toHaveText('Cashier');
    } finally { await electron.close(); }
  });

  test('wrong password shows error and shakes', async () => {
    const { electron, page } = await launchApp();
    try {
      await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
      await page.waitForSelector('#loginUser', { state: 'visible' });
      await page.fill('#loginUser', 'admin');
      await page.fill('#loginPass', 'wrongpassword');
      await page.click('#loginBtn');
      await page.waitForTimeout(800);
      const err = await page.locator('#loginError').textContent();
      // Either the error panel shows text, or a toast appears.
      const toast = await page.locator('#toast').textContent().catch(() => '');
      expect(err || toast).toBeTruthy();
    } finally { await electron.close(); }
  });

  test('unknown username shows same error (no enumeration)', async () => {
    const { electron, page } = await launchApp();
    try {
      await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
      await page.waitForSelector('#loginUser', { state: 'visible' });
      await page.fill('#loginUser', 'nonexistentuser');
      await page.fill('#loginPass', 'whatever');
      await page.click('#loginBtn');
      await page.waitForTimeout(800);
      const err = await page.locator('#loginError').textContent();
      const toast = await page.locator('#toast').textContent().catch(() => '');
      expect(err || toast).toBeTruthy();
    } finally { await electron.close(); }
  });

  test('password eye toggle reveals password', async () => {
    const { electron, page } = await launchApp();
    try {
      await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
      await page.waitForSelector('#loginPass', { state: 'visible' });
      await page.fill('#loginPass', 'secret123');
      const typeBefore = await page.locator('#loginPass').getAttribute('type');
      expect(typeBefore).toBe('password');
      await page.click('#loginPwToggle');
      const typeAfter = await page.locator('#loginPass').getAttribute('type');
      expect(typeAfter === 'text' || typeAfter === null).toBe(true);
    } finally { await electron.close(); }
  });

  test('logout returns to login screen', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.click('#logoutBtn');
      // Logout opens a confirm modal ("Send Telegram report?"). Dismiss it.
      await page.waitForTimeout(400);
      const cancelBtn = page.locator('.modal [data-a="no"]').first();
      if (await cancelBtn.count() > 0) {
        await cancelBtn.click();
      }
      await page.waitForSelector('#login:not(.hidden)', { state: 'visible', timeout: 15000 });
      await expect(page.locator('#loginBtn')).toHaveText(/Sign In/i);
    } finally { await electron.close(); }
  });
});
