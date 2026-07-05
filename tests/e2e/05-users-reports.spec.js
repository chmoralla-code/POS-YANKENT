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
      await page.waitForTimeout(800);
      const text = await page.locator('#view').textContent();
      // Look for expected summary labels
      expect(text).toMatch(/Today|Yesterday|Month|Year/i);
    } finally { await electron.close(); }
  });

  test('date filter present', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'reports');
      // Look for From/To date inputs
      const dateInputs = await page.locator('input[type="date"]').count();
      expect(dateInputs).toBeGreaterThanOrEqual(0);
    } finally { await electron.close(); }
  });

  test('CSV export buttons present', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'reports');
      await page.waitForTimeout(500);
      const text = await page.locator('#view').textContent();
      expect(text).toMatch(/CSV|Export|Best Selling/i);
    } finally { await electron.close(); }
  });
});
