'use strict';
/* Generate Margin Table — Add Item sync across Margin Table, Inventory, and POS. */
const { test, expect } = require('@playwright/test');
const { launchApp, login, navigate, screenshot } = require('./helpers');

test('Add Item creates one product that is immediately available in all three views', async () => {
  const { electron, page } = await launchApp();
  try {
    await login(page, 'admin', 'admin123');
    await navigate(page, 'margins');

    await expect(page.locator('#mAddItem')).toBeVisible();
    await page.locator('#mAddItem').click();
    const modal = page.locator('.margin-add-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-h')).toContainText('Add Item');
    await expect(modal).toContainText('Margin Table, Products & Inventory, and Point of Sale');

    await page.fill('#mAddName', 'E2E Margin Sync Item');
    await page.fill('#mAddUnit', 'bundle');
    await page.fill('#mAddStock', '7');
    await page.fill('#mAddSource', 'Cogon Test Depot');
    await page.fill('#mAddPrice', '175');
    await page.fill('#mAddLowStock', '2');
    await expect(page.locator('#mAddCostHint')).toContainText('₱160.00 cost and ₱15 profit');
    await screenshot(page, 'margin-add-item-form');

    await page.locator('#mAddSave').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#toast')).toContainText('synced to Margin Table, Inventory & POS');

    const newMarginRow = page.locator('#mReadiness tr.is-recent', { hasText: 'E2E Margin Sync Item' });
    await expect(newMarginRow).toBeVisible();
    await expect(newMarginRow).toContainText('7');
    await expect(newMarginRow.locator('.m-source-input')).toHaveValue('Cogon Test Depot');
    await expect(newMarginRow).toContainText('₱175.00');

    const saved = await page.evaluate(async () => {
      const matches = await window.pos.products.list({ q: 'E2E Margin Sync Item' });
      return matches.length ? window.pos.products.get(matches[0].id) : null;
    });
    expect(saved).toMatchObject({
      name: 'E2E Margin Sync Item',
      category: 'Newly Added Items',
      base_unit: 'bundle',
      stock: 7,
      cost: 160,
      price: 175,
      purchase_source: 'Cogon Test Depot',
      low_stock_threshold: 2,
    });

    await navigate(page, 'products');
    await page.fill('#pSearch', 'E2E Margin Sync Item');
    const inventoryCard = page.locator('#pGrid .prod-card', { hasText: 'E2E Margin Sync Item' });
    await expect(inventoryCard).toBeVisible();
    await expect(inventoryCard).toContainText('₱175.00');
    await expect(inventoryCard).toContainText('Stock: 7 bundle');

    await navigate(page, 'pos');
    await page.fill('#posSearch', 'E2E Margin Sync Item');
    const posCard = page.locator('#posGrid .prod-card', { hasText: 'E2E Margin Sync Item' });
    await expect(posCard).toBeVisible();
    await expect(posCard).toContainText('₱175.00');
    await posCard.click();
    await expect(page.locator('#posCart')).toContainText('E2E Margin Sync Item');
  } finally {
    await electron.close();
  }
});
