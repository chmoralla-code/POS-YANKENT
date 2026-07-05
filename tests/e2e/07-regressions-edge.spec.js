'use strict';
/* Section 10-11 — Edge cases & recently fixed bugs */
const { test, expect } = require('@playwright/test');
const { launchApp, login } = require('./helpers');

test.describe('Recently Fixed Bugs — Regression', () => {
  test('POS has no zoom controls (A−/A+ removed)', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await expect(page.locator('#posZoomIn')).toHaveCount(0);
      await expect(page.locator('#posZoomOut')).toHaveCount(0);
      await expect(page.locator('#posZoomVal')).toHaveCount(0);
    } finally { await electron.close(); }
  });

  test('Products has no zoom controls (A−/A+ removed)', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.click('.nav-item[data-view="products"]');
      await page.waitForTimeout(300);
      await expect(page.locator('#pZoomIn')).toHaveCount(0);
      await expect(page.locator('#pZoomOut')).toHaveCount(0);
      await expect(page.locator('#pZoomVal')).toHaveCount(0);
    } finally { await electron.close(); }
  });

  test('POS search has no Clear button', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await expect(page.locator('#posClear')).toHaveCount(0);
    } finally { await electron.close(); }
  });

  test('Products search has no Clear button', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.click('.nav-item[data-view="products"]');
      await page.waitForTimeout(300);
      await expect(page.locator('#pClear')).toHaveCount(0);
    } finally { await electron.close(); }
  });

  test('Analytics nav item present below POS', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      const analyticsBtn = page.locator('.nav-item[data-view="analytics"]');
      await expect(analyticsBtn).toBeVisible();
      // Verify it's below POS in the DOM order
      const posIdx = await page.locator('.nav-item[data-view="pos"]').evaluate((el) => {
        const all = Array.from(el.parentElement.children);
        return all.indexOf(el);
      });
      const analyticsIdx = await analyticsBtn.evaluate((el) => {
        const all = Array.from(el.parentElement.children);
        return all.indexOf(el);
      });
      expect(analyticsIdx).toBeGreaterThan(posIdx);
    } finally { await electron.close(); }
  });

  test('Analytics view renders with stat cards', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.click('.nav-item[data-view="analytics"]');
      await page.waitForTimeout(800);
      await expect(page.locator('.an-card').first()).toBeVisible();
      const cardText = await page.locator('.an-card').first().textContent();
      expect(cardText.length).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('Send Report button is in the sidebar, not topbar', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      // In sidebar
      await expect(page.locator('aside.sidebar #sendReportBtn')).toBeVisible();
      // NOT in topbar
      await expect(page.locator('header.topbar #sendReportBtn')).toHaveCount(0);
    } finally { await electron.close(); }
  });

  test('auto-startup is not registered in Windows Run key', async () => {
    const { electron, page } = await launchApp();
    try {
      // Query via the app's own preload API (autostart.get reads app.getLoginItemSettings)
      const result = await page.evaluate(() => window.pos && window.pos.autostart && window.pos.autostart.get());
      expect(result && result.enabled).toBe(false);
    } finally { await electron.close(); }
  });
});

test.describe('Edge cases', () => {
  test('empty cart shows error on charge', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      // Ensure empty
      const has = await page.locator('#posCart [data-idx]').count();
      if (has > 0) {
        await page.click('#posVoid');
        await page.waitForTimeout(400);
        const okBtn = page.locator('.modal [data-a="yes"]').first();
        if (await okBtn.count() > 0) await okBtn.click();
        await page.waitForTimeout(300);
      }
      await page.click('#posCharge');
      await page.waitForTimeout(500);
      const toast = await page.locator('#toast').textContent().catch(() => '');
      expect(toast.length).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('app handles rapid navigation without crashing', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      for (const v of ['pos', 'analytics', 'products', 'reports', 'settings', 'users', 'pos']) {
        await page.click(`.nav-item[data-view="${v}"]`);
        await page.waitForTimeout(150);
      }
      // Still alive
      await expect(page.locator('#app:not(.hidden)')).toBeVisible();
    } finally { await electron.close(); }
  });
});
