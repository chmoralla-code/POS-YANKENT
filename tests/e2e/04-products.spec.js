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

  test('Newly Added Items chip shows and filters all 1592 requested products', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await page.click('#pChipsToggle');
      const chip = page.locator('#pChips .chip[data-cat="Newly Added Items"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(/Newly Added Items\s*1592/);
      await chip.click();
      // The grid virtualizes the DOM in batches of 100; verify the complete
      // filtered list through the view model rather than defeating lazy render.
      await expect(page.locator('#pGrid .prod-card')).toHaveCount(100);
      const names = await page.evaluate(() => App.views.products._gridList.map((p) => p.name));
      expect(names).toHaveLength(1592);
      expect(names).toEqual(expect.arrayContaining([
        'GOLDEN CUP Brass Plated Iron Hinges Loose Pin 4x4',
        'Weltex cement 100cc',
        'Bowl small',
        'Firefly led bulb 9w',
        'UNIDEX TEE 3x2',
      ]));
      await page.fill('#pSearch', 'GOLDEN CUP Brass Plated Iron Hinges Loose Pin 4x4');
      await expect(page.locator('#pGrid .prod-card')).toHaveCount(1);
      await expect(page.locator('#pGrid .prod-card')).toContainText('Stock: 12 pcs');
    } finally { await electron.close(); }
  });

  test('cashier Products & Inventory is restricted to the Newly Added Items chip', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await navigate(page, 'products');
      await expect(page.locator('#viewTitle')).toHaveText('Products & Inventory');
      await expect(page.locator('#pChips')).toBeVisible();
      await expect(page.locator('#pChips .chip')).toHaveCount(1);
      const chip = page.locator('#pChips .chip[data-cat="Newly Added Items"]');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveClass(/active/);
      await expect(chip).toContainText(/Newly Added Items\s*1592/);
      await expect(page.locator('#pGrid .prod-card')).toHaveCount(100);
      await expect.poll(() => page.evaluate(() => App.views.products._gridList.length)).toBe(1592);

      // Full catalog administration remains hidden from the cashier.
      for (const selector of ['#catManage', '#pImportCatalog', '#pDeleteAll', '#pAdd', '#pAddSvc', '#pTabs']) {
        await expect(page.locator(selector)).toHaveCount(0);
      }
      await expect(page.locator('#pGrid [data-act="edit"]')).toHaveCount(0);
      await expect(page.locator('#pGrid [data-act="stock"]')).toHaveCount(0);
      await expect(page.locator('#pGrid [data-act="del"]')).toHaveCount(0);

      // A zero-price item exposes only the scoped unit/stock correction.
      await page.fill('#pSearch', 'AMERROCK Concealed Hinge');
      await page.waitForTimeout(400);
      await expect(page.locator('#pGrid .prod-card')).toHaveCount(1);
      await page.click('#pGrid [data-act="cashier-details"]');
      await expect(page.locator('.modal')).toContainText('Edit Unit & Stock');
      await page.fill('#cashierBaseUnit', 'box');
      await page.fill('#cashierStock', '113');
      await page.click('.modal [data-a="save"]');
      await expect(page.locator('#pGrid')).toContainText('Stock: 113 box');

      // A base-open item remains editable even when a separately priced
      // alternate unit is present; the alternate price is protected server-side.
      await page.fill('#pSearch', 'concrete nails #3');
      const mixedCard = page.locator('#pGrid .prod-card', { hasText: 'concrete nails #3' });
      await expect(mixedCard).toBeVisible();
      await mixedCard.getByRole('button', { name: 'Edit unit & stock' }).click();
      await expect(page.locator('.modal')).toContainText('Edit Unit & Stock');
      await page.fill('#cashierStock', '3');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(mixedCard).toContainText('Stock: 3 carton');
    } finally { await electron.close(); }
  });

  test('Products view resets cashier-only state before the next admin session', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await navigate(page, 'products');
      await expect(page.locator('#pChips .chip[data-cat="Newly Added Items"]')).toHaveClass(/active/);
      await expect(page.locator('#pChips')).toBeVisible();

      await page.click('#logoutBtn');
      await page.locator('.modal [data-a="no"]').click();
      await expect(page.locator('#login')).toBeVisible();

      await login(page, 'admin', 'admin123');
      await navigate(page, 'products');
      await expect(page.locator('#pTabs .tab[data-tab="products"]')).toHaveClass(/active/);
      await expect(page.locator('#pChips')).toBeHidden();
      expect(await page.evaluate(() => ({
        tab: App.views.products.tab,
        cat: App.views.products.cat,
        chipsOpen: App.views.products.chipsOpen,
      }))).toEqual({ tab: 'products', cat: 'all', chipsOpen: false });
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
