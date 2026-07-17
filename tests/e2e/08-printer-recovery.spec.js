'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, login, screenshot } = require('./helpers');

async function mockPrinterRecoveryIpc(electron, fixture) {
  await electron.evaluate(({ ipcMain }, data) => {
    globalThis.__printerRecoveryCalls = { status: 0, repair: 0, test: 0 };

    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };

    replace('pos:printer:checkStatus', async () => {
      globalThis.__printerRecoveryCalls.status++;
      return {
        ok: true,
        data: {
          ...data.status,
          driverAvailable: true,
          printerConnected: !!data.status.ready,
          installedPrinters: (data.status.printers || []).map((printer) => printer.name),
          printerDetails: data.status.printers || [],
        },
      };
    });
    replace('pos:printer:windowsStatus', async () => {
      globalThis.__printerRecoveryCalls.status++;
      return { ok: true, data: data.status };
    });
    replace('pos:printer:autoRecover', async () => {
      globalThis.__printerRecoveryCalls.repair++;
      return { ok: true, data: data.repair };
    });
    replace('pos:printer:startupTest', async () => {
      globalThis.__printerRecoveryCalls.test++;
      return { ok: true, data: { ok: true, printer: data.testPrinter || 'POS-58 (1)' } };
    });
  }, fixture);
}

function replacementFixture() {
  const stale = { name: 'POS-58', port: 'USB002', driver: 'POS-58', connected: false };
  const replacement = { name: 'POS-58 (1)', port: 'USB003', driver: 'POS-58', connected: true };
  return {
    status: {
      configured: 'POS-58',
      configuredPrinter: stale,
      printers: [stale, replacement],
      connectedThermalPrinters: [replacement],
      staleThermalPrinters: [stale],
      selected: replacement,
      autoSelected: true,
      code: 'replacement',
      status: 'repair-available',
      ready: false,
      canAutoRecover: true,
      needsSelection: false,
      message: 'A connected replacement printer was found.',
    },
    repair: {
      configured: 'POS-58 (1)',
      configuredPrinter: replacement,
      printers: [stale, replacement],
      connectedThermalPrinters: [replacement],
      staleThermalPrinters: [stale],
      selected: replacement,
      autoSelected: false,
      code: 'configured',
      status: 'ready',
      ready: true,
      canAutoRecover: false,
      needsSelection: false,
      repaired: true,
      previousPrinter: 'POS-58',
      message: 'YANKENT switched from "POS-58" to "POS-58 (1)" on USB003.',
    },
  };
}

test.describe('Printer Recovery', () => {
  test('login screen can inspect a ready printer but cannot send a test print', async () => {
    const ready = replacementFixture().repair;
    const { electron, page } = await launchApp();
    try {
      await mockPrinterRecoveryIpc(electron, { status: ready, repair: ready });
      await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
      await page.click('#printerStatusBar');

      await expect(page.locator('#printerRecoveryDialog')).toBeVisible();
      await expect(page.locator('#printerRecovery')).toContainText('Printer is ready');
      await expect(page.locator('#printerRecoveryTest')).toHaveCount(0);
      await expect(page.locator('#printerRecoverySettings')).toHaveCount(0);

      const calls = await electron.evaluate(() => globalThis.__printerRecoveryCalls);
      expect(calls.test).toBe(0);
    } finally {
      await electron.close();
    }
  });

  test('cashier can safely repair a renamed USB printer and then run a test', async () => {
    const { electron, page } = await launchApp();
    try {
      await mockPrinterRecoveryIpc(electron, replacementFixture());
      await login(page, 'cashier', 'cashier123');

      const trigger = page.locator('#printerRecoveryBtn');
      await expect(trigger).toBeVisible();
      await trigger.focus();
      await page.keyboard.press('Enter');

      await expect(page.locator('#printerRecoveryDialog')).toBeVisible();
      await expect(page.locator('#printerRecovery')).toContainText('Replacement printer found');
      await expect(page.locator('#printerRecovery')).toContainText('POS-58 · disconnected');
      await expect(page.locator('#printerRecovery')).toContainText('POS-58 (1) · USB003');
      await screenshot(page, 'printer-recovery-replacement');

      await page.click('#printerRecoveryRepair');
      await expect(page.locator('#printerRecovery')).toContainText('Printer is ready');
      await expect(page.locator('#printerRecoveryTest')).toBeVisible();

      let calls = await electron.evaluate(() => globalThis.__printerRecoveryCalls);
      expect(calls.repair).toBe(1);
      expect(calls.test).toBe(0);

      await page.click('#printerRecoveryTest');
      await expect(page.locator('#printerRecoveryFeedback')).toContainText('Test print sent to POS-58 (1).');
      calls = await electron.evaluate(() => globalThis.__printerRecoveryCalls);
      expect(calls.test).toBe(1);
    } finally {
      await electron.close();
    }
  });

  test('cashier is not offered automatic recovery when multiple printers are connected', async () => {
    const first = { name: 'POS-58 (1)', port: 'USB002', driver: 'POS-58', connected: true };
    const second = { name: 'POS-58 (2)', port: 'USB003', driver: 'POS-58', connected: true };
    const fixture = {
      status: {
        configured: 'POS-58',
        configuredPrinter: { name: 'POS-58', port: 'USB001', driver: 'POS-58', connected: false },
        printers: [first, second],
        connectedThermalPrinters: [first, second],
        staleThermalPrinters: [],
        selected: null,
        autoSelected: false,
        code: 'disconnected',
        status: 'needs-selection',
        ready: false,
        canAutoRecover: false,
        needsSelection: true,
        message: 'More than one thermal printer is connected.',
      },
      repair: {},
    };

    const { electron, page } = await launchApp();
    try {
      await mockPrinterRecoveryIpc(electron, fixture);
      await login(page, 'cashier', 'cashier123');
      await page.click('#printerRecoveryBtn');

      await expect(page.locator('#printerRecovery')).toContainText('YANKENT will not guess');
      await expect(page.locator('#printerRecovery')).toContainText('POS-58 (1) · USB002');
      await expect(page.locator('#printerRecovery')).toContainText('POS-58 (2) · USB003');
      await expect(page.locator('#printerRecoveryRepair')).toHaveCount(0);
      await expect(page.locator('#printerRecoverySettings')).toHaveCount(0);
      await expect(page.locator('#printerRecovery')).toContainText('Ask an administrator');

      const calls = await electron.evaluate(() => globalThis.__printerRecoveryCalls);
      expect(calls.repair).toBe(0);
      expect(calls.test).toBe(0);
    } finally {
      await electron.close();
    }
  });
});
