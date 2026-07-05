'use strict';
/* Section 4 — Point of Sale (catalog, cart, checkout) */
const { test, expect } = require('@playwright/test');
const { launchApp, login } = require('./helpers');

// Restock one in-stock product so cart tests can add it.
// The seeded catalog ships with stock=0 on all products.
async function restockFirstProduct(page) {
  const result = await page.evaluate(async () => {
    const list = await window.pos.products.list({ includeServices: false });
    const prod = list.find((p) => !p.is_service && p.active !== false && p.active !== 0);
    if (!prod) return null;
    await window.pos.products.setStock(prod.id, 100, 'E2E restock', null, null);
    return prod.id;
  });
  return result;
}

test.describe('POS — Catalog & Navigation', () => {
  test('catalog shows products with price', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posGrid .prod-card', { timeout: 10000 });
      const count = await page.locator('#posGrid .prod-card').count();
      expect(count).toBeGreaterThan(0);
      // First card has name + price
      const firstCard = page.locator('#posGrid .prod-card').first();
      await expect(firstCard.locator('.nm')).not.toBeEmpty();
      await expect(firstCard.locator('.pr')).not.toBeEmpty();
    } finally { await electron.close(); }
  });

  test('category chips collapse and expand', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posChipsToggle');
      // Default collapsed
      await expect(page.locator('#posChips')).toBeHidden();
      // Expand
      await page.click('#posChipsToggle');
      await expect(page.locator('#posChips')).toBeVisible();
      // Collapse back
      await page.click('#posChipsToggle');
      await expect(page.locator('#posChips')).toBeHidden();
    } finally { await electron.close(); }
  });

  test('Products tab and Services tab switch', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('.tab[data-tab="services"]');
      await page.click('.tab[data-tab="services"]');
      await expect(page.locator('.tab[data-tab="services"]')).toHaveClass(/active/);
      await page.click('.tab[data-tab="products"]');
      await expect(page.locator('.tab[data-tab="products"]')).toHaveClass(/active/);
    } finally { await electron.close(); }
  });

  test('tab counts show product/service totals', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posCountProducts');
      const prodCount = await page.locator('#posCountProducts').textContent();
      const svcCount = await page.locator('#posCountServices').textContent();
      expect(Number(prodCount || 0)).toBeGreaterThanOrEqual(0);
      expect(Number(svcCount || 0)).toBeGreaterThanOrEqual(0);
    } finally { await electron.close(); }
  });

  test('search filters product grid', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posGrid .prod-card');
      await page.fill('#posSearch', 'zzznonexistent');
      await page.waitForTimeout(400);
      const count = await page.locator('#posGrid .prod-card').count();
      expect(count).toBe(0);
      await page.fill('#posSearch', '');
      await page.waitForTimeout(400);
      const count2 = await page.locator('#posGrid .prod-card').count();
      expect(count2).toBeGreaterThan(0);
    } finally { await electron.close(); }
  });
});

test.describe('POS — Cart', () => {
  test('clicking a product adds it to cart', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posGrid .prod-card');
      await restockFirstProduct(page);
      // Refresh the POS cache + grid in-place (reload() drops the session)
      await page.evaluate(async () => { if (window.App && App.views && App.views.pos) { await App.views.pos.render(App.views.pos.viewEl); } });
      await page.waitForSelector('#posGrid .prod-card:not(.out-of-stock)', { timeout: 15000 });
      const cards = page.locator('#posGrid .prod-card:not(.out-of-stock)');
      const n = await cards.count();
      let added = false;
      for (let i = 0; i < Math.min(n, 5); i++) {
        await cards.nth(i).click({ force: true });
        await page.waitForTimeout(200);
        if ((await page.locator('#posCart [data-idx]').count()) > 0) { added = true; break; }
      }
      expect(added).toBe(true);
    } finally { await electron.close(); }
  });

  test('void button empties cart', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posGrid .prod-card');
      await restockFirstProduct(page);
      await page.evaluate(async () => { if (window.App && App.views && App.views.pos) { await App.views.pos.render(App.views.pos.viewEl); } });
      await page.waitForSelector('#posGrid .prod-card:not(.out-of-stock)', { timeout: 15000 });
      const cards = page.locator('#posGrid .prod-card:not(.out-of-stock)');
      const n = await cards.count();
      let added = false;
      for (let i = 0; i < Math.min(n, 5); i++) {
        await cards.nth(i).click({ force: true });
        await page.waitForTimeout(200);
        if ((await page.locator('#posCart [data-idx]').count()) > 0) { added = true; break; }
      }
      expect(added).toBe(true);
      // Void opens an App.ui.confirm modal — click OK (data-a="yes")
      await page.click('#posVoid');
      await page.waitForTimeout(400);
      const okBtn = page.locator('.modal [data-a="yes"]').first();
      if (await okBtn.count() > 0) {
        await okBtn.click();
      }
      await page.waitForTimeout(400);
      const hasLines = await page.locator('#posCart [data-idx]').count();
      expect(hasLines).toBe(0);
    } finally { await electron.close(); }
  });

  test('charge on empty cart shows error', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posCharge');
      // Ensure cart is empty
      const hasLines = await page.locator('#posCart [data-idx]').count();
      if (hasLines > 0) {
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

  test('payment methods toggle', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posPay button[data-pay="card"]');
      await page.click('#posPay button[data-pay="card"]');
      await expect(page.locator('#posPay button[data-pay="card"]')).toHaveClass(/active/);
      await page.click('#posPay button[data-pay="cash"]');
      await expect(page.locator('#posPay button[data-pay="cash"]')).toHaveClass(/active/);
    } finally { await electron.close(); }
  });
});
