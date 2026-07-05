'use strict';
/* Section 3 — Role-Based Access */
const { test, expect } = require('@playwright/test');
const { launchApp, login } = require('./helpers');

test.describe('Role-Based Access', () => {
  test('cashier sees only POS and Analytics', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      // POS active by default
      await expect(page.locator('.nav-item[data-view="pos"]')).toHaveClass(/active/);
      // Analytics visible
      await expect(page.locator('.nav-item[data-view="analytics"]')).toBeVisible();
      // Admin items hidden
      await expect(page.locator('.nav-item[data-view="products"]')).toHaveClass(/hidden/);
      await expect(page.locator('.nav-item[data-view="users"]')).toHaveClass(/hidden/);
      await expect(page.locator('.nav-item[data-view="reports"]')).toHaveClass(/hidden/);
      await expect(page.locator('.nav-item[data-view="settings"]')).toHaveClass(/hidden/);
    } finally { await electron.close(); }
  });

  test('admin sees all nav items', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      for (const v of ['pos', 'analytics', 'products', 'users', 'reports', 'settings']) {
        const el = page.locator(`.nav-item[data-view="${v}"]`);
        await expect(el).toBeVisible();
        await expect(el).not.toHaveClass(/hidden/);
      }
    } finally { await electron.close(); }
  });

  test('Send Report button visible to both roles', async () => {
    for (const [user, pass] of [['admin', 'admin123'], ['cashier', 'cashier123']]) {
      const { electron, page } = await launchApp();
      try {
        await login(page, user, pass);
        await expect(page.locator('#sendReportBtn')).toBeVisible();
      } finally { await electron.close(); }
    }
  });
});
