'use strict';
/* Section 5 — Products & Inventory */
const { test, expect } = require('@playwright/test');
const { launchApp, login, navigate } = require('./helpers');

test.describe('Products & Inventory', () => {
  test('product grid loads', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.waitForSelector('#pGrid .prod-card', { timeout: 10000 });
      const count = await page.locator('#pGrid .prod-card').count();
      expect(count).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('category chips collapse and expand', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.waitForSelector('#pChipsToggle');
      await expect(page.locator('#pChips')).toBeHidden();
      await page.click('#pChipsToggle');
      await expect(page.locator('#pChips')).toBeVisible();
      await page.click('#pChipsToggle');
      await expect(page.locator('#pChips')).toBeHidden();
    } finally { await electron.close(); }
  });

  test('search filters product list', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.waitForSelector('#pGrid .prod-card');
      await page.fill('#pSearch', 'zzznonexistent');
      await page.waitForTimeout(400);
      const count = await page.locator('#pGrid .prod-card').count();
      expect(count).toBe(0);
      await page.fill('#pSearch', '');
      await page.waitForTimeout(400);
      expect(await page.locator('#pGrid .prod-card').count()).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('add product modal opens', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.click('#pAdd');
      await page.waitForSelector('.modal', { timeout: 5000 });
      await expect(page.locator('.modal')).toContainText(/Add Product/i);
      // Cancel
      await page.click('.modal [data-a="cancel"]');
    } finally { await electron.close(); }
  });

  test('add service modal opens', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.click('#pAddSvc');
      await page.waitForSelector('.modal', { timeout: 5000 });
      await expect(page.locator('.modal')).toContainText(/Add Service/i);
      await page.click('.modal [data-a="cancel"]');
    } finally { await electron.close(); }
  });

  test('create a new service end-to-end', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.click('#pAddSvc');
      await page.waitForSelector('#fName');
      await page.fill('#fName', 'E2E Test Service');
      await page.fill('#fPrice', '250');
      await page.click('.modal [data-a="save"]');
      await page.waitForTimeout(500);
      // Verify it shows in services (search by name)
      await page.fill('#pSearch', 'E2E Test Service');
      await page.waitForTimeout(400);
      expect(await page.locator('#pGrid .prod-card').count()).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('manage categories modal opens', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.click('#catManage');
      await page.waitForSelector('.modal', { timeout: 5000 });
      await expect(page.locator('.modal')).toContainText(/Manage Categories/i);
      await page.click('.modal [data-a="done"]');
    } finally { await electron.close(); }
  });
});
