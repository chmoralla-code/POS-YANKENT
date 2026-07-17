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
      await expect(firstCard).toHaveAttribute('type', 'button');
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
      await page.locator('.tab[data-tab="products"]').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.tab[data-tab="services"]')).toHaveClass(/active/);
      await expect(page.locator('.tab[data-tab="services"]')).toHaveAttribute('aria-selected', 'true');
      await page.click('.tab[data-tab="products"]');
      await expect(page.locator('.tab[data-tab="products"]')).toHaveClass(/active/);
      await expect(page.locator('.tab[data-tab="products"]')).toHaveAttribute('aria-selected', 'true');
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
      await expect(page.locator('#posCart [data-act="minus"]')).toHaveAttribute('aria-label', /Decrease quantity/);
      await expect(page.locator('#posCart [data-act="plus"]')).toHaveAttribute('aria-label', /Increase quantity/);
      await expect(page.locator('#posCart [data-act="rm"]')).toHaveAttribute('aria-label', /Remove .* from cart/);
      await expect(page.locator('#posCart input[data-field="qty"]')).toHaveAttribute('aria-label', /Quantity for/);
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
      await expect(page.locator('#posPay button[data-pay="card"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#posPay button[data-pay="cash"]')).toHaveAttribute('aria-pressed', 'false');
      await page.click('#posPay button[data-pay="cash"]');
      await expect(page.locator('#posPay button[data-pay="cash"]')).toHaveClass(/active/);
      await expect(page.locator('#posPay button[data-pay="cash"]')).toHaveAttribute('aria-pressed', 'true');
    } finally { await electron.close(); }
  });
});

test.describe('POS — Cashier refund controls', () => {
  test('cashier refund requires an administrator password and a reason', async () => {
    const adminApp = await launchApp();
    let txnId;
    try {
      await login(adminApp.page, 'admin', 'admin123');
      txnId = await adminApp.page.evaluate(async () => {
        const products = await window.pos.products.list({ includeServices: false });
        const product = products.find((p) => !p.is_service && p.active !== false && p.active !== 0);
        if (!product) throw new Error('No product available for refund test');
        await window.pos.products.setStock(product.id, 5, 'Refund E2E stock', null, null);
        const unit = (product.units && product.units[0]) || { unit: product.base_unit, price: product.price };
        const sale = await window.pos.sales.create({
          items: [{ productId: product.id, unit: unit.unit, qty: 1 }],
          paymentMethod: 'cash',
          amountTendered: Number(unit.price) || 0,
        });
        await window.pos.sales.commit(sale.txnId);
        return sale.txnId;
      });
    } finally { await adminApp.electron.close(); }

    const cashierApp = await launchApp({ resetDb: false });
    try {
      const page = cashierApp.page;
      await login(page, 'cashier', 'cashier123');
      await page.locator('#posRefund').click();
      await page.locator('#rfTxn').fill(txnId);
      await page.locator('[data-a="lookup"]').click();
      await expect(page.locator('#rfAdminPin')).toBeVisible();
      await expect(page.locator('#rfReason')).toBeVisible();

      await page.locator('#rfReason').fill('Customer return');
      await page.locator('[data-a="refund"]').click();
      await expect(page.locator('#toast')).toContainText('Administrator password is required');

      await page.locator('#rfAdminPin').fill('wrong-password');
      await page.locator('[data-a="refund"]').click();
      await expect(page.locator('#toast')).toContainText('Administrator password is incorrect');
    } finally { await cashierApp.electron.close(); }
  });
});
