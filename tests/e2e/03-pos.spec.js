'use strict';
/* Section 4 — Point of Sale (catalog, cart, checkout) */
const { test, expect } = require('@playwright/test');
const { launchApp, login } = require('./helpers');

// Restock one fixed-price product so cart tests do not accidentally select
// an open-price item and wait on its price-entry modal.
async function restockPricedProduct(page) {
  const result = await page.evaluate(async () => {
    const list = await window.pos.products.list({ includeServices: false });
    const prod = list.find((p) =>
      !p.is_service &&
      p.active !== false &&
      p.active !== 0 &&
      Array.isArray(p.units) &&
      p.units.some((unit) => Number(unit.price) > 0)
    );
    if (!prod) return null;
    await window.pos.products.setStock(prod.id, 100, 'E2E restock', null, null);
    return { id: prod.id, name: prod.name };
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

  test('Newly Added Items chip filters the POS grid to the 1592 requested products', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.click('#posChipsToggle');
      const chip = page.locator('#posChips .chip[data-cat="Newly Added Items"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(/Newly Added Items\s*1592/);
      await chip.click();
      // The grid intentionally keeps one 100-card batch in the DOM. Verify
      // distant catalog entries through the user-facing search interaction.
      await expect(page.locator('#posGrid .prod-card')).toHaveCount(100);
      for (const name of [
        'GOLDEN CUP Brass Plated Iron Hinges Loose Pin 4x4',
        'Weltex cement 100cc',
        'Bowl small',
        'Firefly led bulb 9w',
        'UNIDEX TEE 3x2',
      ]) {
        await page.fill('#posSearch', name);
        await expect(page.locator('#posGrid .prod-card')).toHaveCount(1);
        await expect(page.locator('#posGrid .prod-card').first()).toContainText(name);
      }
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

  test('cashier sees outside-category open-price items as unavailable', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await page.fill('#posSearch', 'LF Paint Brush #2');
      const card = page.locator('#posGrid .prod-card', { hasText: 'LF Paint Brush #2' });
      await expect(card).toHaveCount(1);
      await expect(card).toBeDisabled();
      await expect(card).toContainText('Price unavailable');
      await expect(card).toContainText('PRICE UNAVAILABLE');

      // Programmatic activation mirrors an unexpected delegated click while
      // proving that the disabled card cannot open the correction modal.
      await card.evaluate((element) => element.click());
      await expect(page.locator('.modal')).toHaveCount(0);
      await expect(page.locator('#posCart [data-idx]')).toHaveCount(0);
    } finally { await electron.close(); }
  });
});

test.describe('POS — Cart', () => {
  test('cashier can price and correct a Newly Added open-price item', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await page.fill('#posSearch', 'AMERROCK Concealed Hinge');
      const card = page.locator('#posGrid .prod-card', { hasText: 'AMERROCK Concealed Hinge' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Set price');
      await card.click();

      await expect(page.locator('.modal')).toContainText('Set details');
      await page.fill('#openPrice', '12.50');
      await page.fill('#openUnit', 'box');
      await page.fill('#openStock', '113');
      await page.locator('.modal [data-a="ok"]').click();

      await expect(page.locator('#posCart [data-idx]')).toHaveCount(1);
      await expect(page.locator('#posCart')).toContainText('AMERROCK Concealed Hinge');
      await expect(page.locator('#posCart input[data-field="price"]')).toHaveValue('12.5');
      await expect(page.locator('#posCart input[data-field="openUnit"]')).toHaveValue('box');
      const saved = await page.evaluate(async () => {
        const products = await window.pos.products.list({ includeServices: false, q: 'AMERROCK Concealed Hinge' });
        return products[0];
      });
      expect(saved.base_unit).toBe('box');
      expect(saved.stock).toBe(113);
      expect(saved.price).toBe(0);
    } finally { await electron.close(); }
  });

  test('mixed-price alternate units survive a base rename and checkout', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'cashier', 'cashier123');
      await page.fill('#posSearch', 'concrete nails #3');
      const card = page.locator('#posGrid .prod-card', { hasText: 'concrete nails #3' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Set price');

      // First line uses the open-price base unit.
      await card.click();
      await page.fill('#openPrice', '100');
      await page.fill('#openStock', '3');
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.locator('#posCart [data-idx]')).toHaveCount(1);
      await expect(page.locator('#posCart select[data-field="unit"]')).toHaveValue('carton');

      // A second price plus a corrected base label creates a second line.
      // The first line must follow the rename instead of retaining a deleted
      // unit that would make checkout fail.
      await card.click();
      await page.fill('#openPrice', '110');
      await page.fill('#openUnit', 'box');
      await page.getByRole('button', { name: 'Add to cart' }).click();
      await expect(page.locator('#posCart [data-idx]')).toHaveCount(2);
      const unitSelects = page.locator('#posCart select[data-field="unit"]');
      await expect(unitSelects).toHaveCount(2);
      await expect(unitSelects.nth(0)).toHaveValue('box');
      await expect(unitSelects.nth(1)).toHaveValue('box');

      // The separately priced alternate remains available and authoritative.
      const firstLine = page.locator('#posCart [data-idx]').first();
      await firstLine.locator('select[data-field="unit"]').selectOption('kg');
      await expect(firstLine.locator('.meta')).toContainText('₱90.00 / kg');
      await expect(page.locator('#posCharge')).toContainText('₱200.00');
      await firstLine.locator('select[data-field="unit"]').selectOption('box');
      await expect(firstLine.locator('input[data-field="price"]')).toHaveValue('100');
      await expect(page.locator('#posCharge')).toContainText('₱210.00');
      await firstLine.locator('select[data-field="unit"]').selectOption('kg');
      await expect(firstLine.locator('.meta')).toContainText('₱90.00 / kg');
      await expect(page.locator('#posCharge')).toContainText('₱200.00');

      await page.locator('#posCharge').click();
      await page.getByRole('button', { name: 'Confirm & Print' }).click();
      await expect(page.locator('.modal-h span')).toContainText('Receipt');
      await page.locator('.modal .x').click();
    } finally { await electron.close(); }
  });

  test('clicking a product adds it to cart', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.waitForSelector('#posGrid .prod-card');
      const product = await restockPricedProduct(page);
      expect(product).toBeTruthy();
      // Refresh the POS cache + grid in-place (reload() drops the session)
      await page.evaluate(async () => { if (window.App && App.views && App.views.pos) { await App.views.pos.render(App.views.pos.viewEl); } });
      await page.fill('#posSearch', product.name);
      const card = page.locator('#posGrid .prod-card', { hasText: product.name });
      await expect(card).toBeVisible();
      await card.click();
      await expect(page.locator('#posCart [data-idx]')).toHaveCount(1);
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
      const product = await restockPricedProduct(page);
      expect(product).toBeTruthy();
      await page.evaluate(async () => { if (window.App && App.views && App.views.pos) { await App.views.pos.render(App.views.pos.viewEl); } });
      await page.fill('#posSearch', product.name);
      const card = page.locator('#posGrid .prod-card', { hasText: product.name });
      await expect(card).toBeVisible();
      await card.click();
      await expect(page.locator('#posCart [data-idx]')).toHaveCount(1);
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

  test('checkout saves entered cash and electronic payment references', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await page.evaluate(async () => {
        await window.pos.products.create({
          sku: 'E2E-PAY',
          name: 'E2E Payment Item',
          base_unit: 'pc',
          stock: 10,
          cost: 0,
          price: 30,
          low_stock_threshold: 1,
          is_service: false,
          units: [{ unit: 'pc', factor: 1, price: 30 }],
        });
      });
      await page.click('.nav-item[data-view="products"]');
      await page.click('.nav-item[data-view="pos"]');
      await page.waitForSelector('#posSearch');
      await page.fill('#posSearch', 'E2E Payment Item');
      await page.waitForTimeout(400);
      await page.locator('.prod-card', { hasText: 'E2E Payment Item' }).click();

      await page.click('#posCharge');
      await page.fill('#payCash', '20');
      await page.locator('.modal [data-a="ok"]').click();
      await expect(page.locator('#toast')).toContainText('less than the amount due');
      await expect(page.locator('#payCash')).toBeVisible();
      await page.fill('#payCash', '50');
      await page.locator('.modal [data-a="ok"]').click();
      await expect(page.locator('.modal-h span')).toContainText('Receipt');
      const cashTxn = (await page.locator('.modal-h span').textContent()).match(/YK-\d+/)[0];
      const cashSale = await page.evaluate((txn) => window.pos.sales.get(txn), cashTxn);
      expect(cashSale.amount_tendered).toBe(50);
      expect(cashSale.change).toBe(20);
      await page.locator('.modal .x').click();

      await page.click('#posPay button[data-pay="card"]');
      await page.click('#posCharge');
      await page.fill('#payRef', 'CARD-E2E-REFERENCE');
      await page.locator('.modal [data-a="ok"]').click();
      await expect(page.locator('.modal-h span')).toContainText('Receipt');
      const cardTxn = (await page.locator('.modal-h span').textContent()).match(/YK-\d+/)[0];
      const cardSale = await page.evaluate((txn) => window.pos.sales.get(txn), cardTxn);
      expect(cardSale.reference).toBe('CARD-E2E-REFERENCE');
      expect(cardSale.amount_tendered).toBe(0);
      await page.locator('.modal .x').click();
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
        const candidate = products
          .filter((p) => !p.is_service && p.active !== false && p.active !== 0)
          .map((product) => ({
            product,
            unit: (product.units || []).find((entry) => Number(entry.price) > 0),
          }))
          .find((entry) => entry.unit);
        if (!candidate) throw new Error('No fixed-price product available for refund test');
        const { product, unit } = candidate;
        await window.pos.products.setStock(product.id, 5, 'Refund E2E stock', null, null);
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
