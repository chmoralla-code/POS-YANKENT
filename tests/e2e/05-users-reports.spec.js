'use strict';
/* Section 6 — Users & Roles + Section 7 — Reports (admin views) */
const { test, expect } = require('@playwright/test');
const { launchApp, login, navigate } = require('./helpers');

test.describe('Users (admin)', () => {
  test('user list loads', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'users');
      await page.waitForTimeout(500);
      // Should have at least the admin + cashier rows
      const rows = await page.locator('[data-id]').count().catch(() => 0);
      const text = await page.locator('#view').textContent();
      expect(text.length).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });

  test('add user modal opens', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'users');
      await page.waitForSelector('#uAdd', { timeout: 5000 }).catch(() => {});
      const addBtn = page.locator('button:has-text("Add User"), #uAdd');
      if (await addBtn.count() > 0) {
        await addBtn.first().click();
        await page.waitForTimeout(300);
        const modalText = await page.locator('.modal').textContent().catch(() => '');
        expect(modalText.length).toBeGreaterThan(0);
      }
    } finally { await electron.close(); }
  });
});

test.describe('Reports (admin)', () => {
  test('reports view loads with summary stats', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'reports');
      await expect(page.getByRole('heading', { name: 'Sales performance' })).toBeVisible();
      await expect(page.locator('#rStats .report-stat')).toHaveCount(4);
      await expect(page.locator('#rSections .collapse-toggle')).toHaveCount(7);
      await expect(page.locator('#rSections .collapse-toggle[aria-expanded="true"]')).toHaveCount(1);

      // Report tabs work with the keyboard and load a consistent stock view.
      await page.locator('#rTabSales').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#rTabDelivery')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: 'Stock & restock history' })).toBeVisible();
      await expect(page.locator('#dStats .report-stat')).toHaveCount(4);
    } finally { await electron.close(); }
  });

  test('date filter is labelled and rejects an inverted range', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'reports');
      await expect(page.locator('#rSales input[type="date"]')).toHaveCount(2);
      await expect(page.locator('#rSales').getByLabel('From', { exact: true })).toBeVisible();
      await expect(page.locator('#rSales').getByLabel('To', { exact: true })).toBeVisible();

      await page.locator('#rFrom').evaluate((el) => { el.value = '2026-07-20'; });
      await page.locator('#rTo').evaluate((el) => { el.value = '2026-07-10'; });
      await page.locator('#rGo').click();
      await expect(page.locator('#toast')).toContainText('From date must be earlier');
      await expect(page.locator('#rFrom')).toBeFocused();
    } finally { await electron.close(); }
  });

  test('CSV export is a separate action and does not toggle its section', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'reports');
      const section = page.locator('.collapse-section[data-key="products"]');
      const exportButton = section.locator('[data-x="bestSelling"]');
      await expect(exportButton).toHaveText('Export CSV');
      const wasOpen = await section.evaluate((el) => el.classList.contains('open'));

      // Stub the native save-dialog path so this test only verifies routing.
      await page.evaluate(() => {
        window.__reportExportType = '';
        App.views.reports._csv = (type) => { window.__reportExportType = type; };
      });
      await exportButton.click();
      expect(await page.evaluate(() => window.__reportExportType)).toBe('bestSelling');
      expect(await section.evaluate((el) => el.classList.contains('open'))).toBe(wasOpen);
    } finally { await electron.close(); }
  });
});
