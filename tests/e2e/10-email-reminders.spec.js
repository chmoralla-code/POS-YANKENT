'use strict';
/* Customer-facing Utang email reminder controls */
const { test, expect } = require('@playwright/test');
const { launchApp, login, navigate, screenshot } = require('./helpers');

test.describe('Utang email reminders', () => {
  test('new customer defaults to 15 days and preference persists', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'utang');
      await expect(page.locator('#utangReminder')).toContainText('Customer email reminders');
      await page.click('#utangAdd');
      await expect(page.locator('#upEmailReminder')).toBeChecked();
      await expect(page.locator('#upReminderDays')).toHaveValue('15');
      await expect(page.locator('#upEmail')).toHaveAttribute('required', '');
      await screenshot(page, 'utang-email-reminder-form');

      await page.fill('#upName', 'Reminder Test Client');
      await page.fill('#upEmail', 'client@example.com');
      await page.fill('#upReminderDays', '9');
      await page.click('.modal [data-a="save"]');
      await expect(page.locator('#utangRows')).toContainText('Reminder Test Client');
      await page.locator('[data-customer-id]').filter({ hasText: 'Reminder Test Client' }).first().click();
      await expect(page.locator('.modal')).toContainText('9 days before due');
    } finally { await electron.close(); }
  });

  test('settings exposes protected Resend configuration and fixed sender name', async () => {
    const { electron, page } = await launchApp();
    try {
      await login(page, 'admin', 'admin123');
      await navigate(page, 'settings');
      const section = page.locator('.collapse-section[data-key="email"]');
      await expect(section).toContainText('Customer Email Reminders');
      await section.locator('.collapse-h').click();
      await expect(page.locator('#s_resend_api_key')).toHaveAttribute('type', 'password');
      await expect(page.locator('#s_resend_from_email')).toHaveAttribute('type', 'email');
      await expect(section).toContainText('YANKENT CONSTRUCTION');
    } finally { await electron.close(); }
  });
});
