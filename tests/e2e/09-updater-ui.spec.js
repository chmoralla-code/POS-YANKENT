'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp } = require('./helpers');

const UPDATE = {
  currentVersion: '2.0.5',
  version: '2.1.0',
  releaseNotes: '- Added safer remote updates\n- Fixed background download errors',
};

const GITHUB_HTML_UPDATE = {
  currentVersion: '1.0.0',
  version: '2.2.6',
  releaseNotes: '<p>Secure remote updates, printer recovery, reports, cashier, and UI improvements.</p>',
};

async function waitForRenderer(page) {
  await page.waitForSelector('#startup', { state: 'detached', timeout: 30000 });
  await expect(page.locator('#loginCheckUpdates')).toBeVisible();
}

test.describe('Updater UI reliability', () => {
  test("What's New turns GitHub HTML into a safe, focused release summary", async () => {
    const { electron, page } = await launchApp();
    try {
      await waitForRenderer(page);
      const returnTarget = page.locator('#loginCheckUpdates');
      await returnTarget.focus();

      await page.evaluate((update) => {
        window.__whatsNewResult = 'pending';
        void App._showWhatsNew(update).then((result) => {
          window.__whatsNewResult = result;
        });
      }, GITHUB_HTML_UPDATE);

      const dialog = page.getByRole('dialog', { name: "What's New" });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.wn-from')).toHaveText('v1.0.0');
      await expect(dialog.locator('.wn-to')).toHaveText('v2.2.6');
      await expect(dialog.locator('.wn-total')).toHaveText('5 highlights');
      await expect(dialog.locator('.wn-item')).toHaveText([
        'Secure remote updates',
        'Printer recovery',
        'Reports',
        'Cashier',
        'UI improvements',
      ]);
      await expect(dialog).not.toContainText('<p>');
      await expect(dialog).not.toContainText('Other');
      await expect(dialog.locator('script, img')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Download update' })).toBeFocused();
      await expect(page.locator('#login')).toHaveJSProperty('inert', true);
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Download update' })).toBeFocused();

      if (process.env.WHATS_NEW_SCREENSHOT) {
        await page.screenshot({ path: process.env.WHATS_NEW_SCREENSHOT });
      }

      await dialog.getByRole('button', { name: 'Not now' }).click();
      await expect.poll(() => page.evaluate(() => window.__whatsNewResult)).toBe(false);
      await expect(page.locator('#login')).toHaveJSProperty('inert', false);
      await expect(returnTarget).toBeFocused();

      await page.evaluate((update) => {
        window.__whatsNewResult = 'pending';
        void App._showWhatsNew(update).then((result) => {
          window.__whatsNewResult = result;
        });
      }, GITHUB_HTML_UPDATE);
      await page.getByRole('dialog', { name: "What's New" }).getByRole('button', { name: 'Download update' }).click();
      await expect.poll(() => page.evaluate(() => window.__whatsNewResult)).toBe(true);
    } finally {
      await electron.close();
    }
  });

  test("What's New resolves false when dismissed by X or overlay", async () => {
    const { electron, page } = await launchApp();
    try {
      await waitForRenderer(page);

      for (const dismissal of ['x', 'overlay']) {
        await page.evaluate((update) => {
          window.__whatsNewResult = 'pending';
          void App._showWhatsNew(update).then((result) => {
            window.__whatsNewResult = result;
          });
        }, UPDATE);

        const overlay = page.locator('.modal-overlay').last();
        await expect(overlay).toBeVisible();
        await expect(overlay.locator('.modal-h')).toContainText("What's New");

        if (dismissal === 'x') {
          await overlay.locator('.x').click();
        } else {
          // Click the overlay's top-left corner, outside the centered modal.
          await overlay.click({ position: { x: 2, y: 2 } });
        }

        await expect(overlay).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.__whatsNewResult)).toBe(false);
      }
    } finally {
      await electron.close();
    }
  });

  test('hidden background download failure resolves false and removes all listeners', async () => {
    const { electron, page } = await launchApp();
    try {
      await waitForRenderer(page);

      await page.evaluate((update) => {
        const subscriptions = new Map();
        const removed = [];
        let nextId = 1;
        let rejectDownload;
        const subscribe = (type, callback) => {
          const id = nextId++;
          subscriptions.set(id, { type, callback });
          return id;
        };

        const updateMock = {
          onDownloadProgress: (callback) => subscribe('progress', callback),
          onDownloaded: (callback) => subscribe('downloaded', callback),
          onError: (callback) => subscribe('error', callback),
          off: (id) => {
            removed.push(id);
            return subscriptions.delete(id);
          },
          download: () => new Promise((_resolve, reject) => {
            rejectDownload = reject;
          }),
        };

        // The contextBridge API is frozen, so replace App.pos with a shallow
        // renderer-owned facade instead of mutating window.pos.
        App.pos = { ...App.pos, update: updateMock };
        window.__backgroundDownload = {
          result: 'pending',
          fail: () => rejectDownload(new Error('Simulated GitHub connection failure')),
          inspect: () => ({
            activeIds: Array.from(subscriptions.keys()),
            removed: removed.slice(),
          }),
        };

        void App._showDownloadProgress(update).then((result) => {
          window.__backgroundDownload.result = result;
        });
      }, UPDATE);

      const overlay = page.locator('.modal-overlay').last();
      await expect(overlay).toBeVisible();
      await overlay.locator('[data-a="hide"]').click();
      await expect(overlay).toHaveCount(0);

      await page.evaluate(() => window.__backgroundDownload.fail());
      await expect.poll(() => page.evaluate(() => window.__backgroundDownload.result)).toBe(false);

      const subscriptions = await page.evaluate(() => window.__backgroundDownload.inspect());
      expect(subscriptions.activeIds).toEqual([]);
      expect(subscriptions.removed).toEqual([1, 2, 3]);
      await expect(page.locator('#toast')).toContainText('Simulated GitHub connection failure');
    } finally {
      await electron.close();
    }
  });

  test('rapid repeated checks share one in-flight update request', async () => {
    const { electron, page } = await launchApp();
    try {
      await waitForRenderer(page);

      await page.evaluate(() => {
        let resolveCheck;
        const pendingCheck = new Promise((resolve) => {
          resolveCheck = resolve;
        });
        let calls = 0;
        const updateMock = {
          ...App.pos.update,
          check: () => {
            calls += 1;
            return pendingCheck;
          },
        };
        App.pos = { ...App.pos, update: updateMock };

        const first = App._checkUpdates();
        const second = App._checkUpdates();
        const third = App._checkUpdates();
        window.__checkConcurrency = {
          calls: () => calls,
          samePromise: first === second && second === third,
          settled: false,
          results: null,
          release: () => resolveCheck({ devMode: true, available: false, currentVersion: '2.0.5' }),
        };
        void Promise.all([first, second, third]).then((results) => {
          window.__checkConcurrency.results = results;
          window.__checkConcurrency.settled = true;
        });
      });

      expect(await page.evaluate(() => window.__checkConcurrency.calls())).toBe(1);
      expect(await page.evaluate(() => window.__checkConcurrency.samePromise)).toBe(true);
      await expect(page.locator('#loginCheckUpdates')).toHaveText('Checking…');
      await expect(page.locator('#loginCheckUpdates')).toHaveAttribute('aria-disabled', 'true');

      await page.evaluate(() => window.__checkConcurrency.release());
      await expect.poll(() => page.evaluate(() => window.__checkConcurrency.settled)).toBe(true);
      expect(await page.evaluate(() => window.__checkConcurrency.calls())).toBe(1);
      expect(await page.evaluate(() => window.__checkConcurrency.results)).toEqual([true, true, true]);
      await expect(page.locator('#loginCheckUpdates')).toHaveText('Check for updates');
      await expect(page.locator('#loginCheckUpdates')).not.toHaveAttribute('aria-disabled', 'true');
    } finally {
      await electron.close();
    }
  });
});
