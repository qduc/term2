import { expect, type Page } from '@playwright/test';
import { openDraftChat, test } from './flow-helpers.js';

/**
 * The settings page reads and writes the page's one settings projection (web-client/lib/term2/data/server-data.ts):
 * writes queue, each against the newest revision, so a change made while another is saving is not refused as a
 * conflict.
 */

const section = (page: Page, label: string) =>
  page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click();

test('two settings changed one after the other on the settings page are both saved', async ({ page, launch }) => {
  const app = await launch({ scripts: {} });
  await openDraftChat(page, app);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  const memory = page.getByRole('switch', { name: 'Personal memory' });
  const review = page.getByRole('switch', { name: 'Show the safety review' });
  await section(page, 'Conversation');
  const memoryBefore = await memory.getAttribute('aria-checked');
  await section(page, 'Approvals and safety');
  const reviewBefore = await review.getAttribute('aria-checked');

  // The first write is held at the boundary until the second change has been made.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let seen!: () => void;
  const arrived = new Promise<void>((resolve) => (seen = resolve));
  let held = false;
  await page.route('**/api/term2/settings', async (route) => {
    if (!held && route.request().method() === 'PUT') {
      held = true;
      seen();
      await released;
    }
    await route.fallback();
  });
  await section(page, 'Conversation');
  await memory.click();
  await arrived;
  await section(page, 'Approvals and safety');
  await review.click();
  release();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // Both changes are on the server: a reload at the same address shows them.
  await page.reload();
  await expect(review).not.toHaveAttribute('aria-checked', reviewBefore ?? '');
  await section(page, 'Conversation');
  await expect(memory).not.toHaveAttribute('aria-checked', memoryBefore ?? '');

  // Back leaves the settings page (the draft did not survive the reload, so it is the welcome screen).
  await page.goBack();
  await expect(page).not.toHaveURL(/settings=/);
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
});

test('opening the settings page by its address never shows its load error on the way', async ({ page, launch }) => {
  const app = await launch({ scripts: {} });
  // Records whether the load-error screen was ever on the page, however briefly.
  await page.addInitScript(() => {
    const w = window as unknown as { __settingsError: boolean };
    w.__settingsError = false;
    new MutationObserver(() => {
      if (document.body?.innerText.includes('Settings could not be loaded')) w.__settingsError = true;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(`${app.origin}/?settings=conversation`);
    await expect(page.getByRole('switch', { name: 'Personal memory' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __settingsError: boolean }).__settingsError)).toBe(false);
  }
});

test('a settings page whose own read answered still saves when the start-up read failed', async ({ page, launch }) => {
  const app = await launch({ scripts: {} });
  // On a direct load the page's own read goes first and the start-up read second; the second fails.
  let gets = 0;
  await page.route('**/api/term2/settings', async (route) => {
    if (route.request().method() === 'GET' && ++gets === 2) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":{"code":"internal","message":"start-up read failed"}}',
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${app.origin}/?settings=conversation`);
  const memory = page.getByRole('switch', { name: 'Personal memory' });
  await expect(memory).toBeVisible();
  await expect.poll(() => gets).toBe(2);
  const before = await memory.getAttribute('aria-checked');
  await memory.click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(memory).not.toHaveAttribute('aria-checked', before ?? '');
});
