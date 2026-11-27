import { expect } from '@playwright/test';
import { expectNoRunningTurn, openDraftChat, send, test, turns } from './flow-helpers.js';
import type { WebApp } from './launch.js';

/** The chip's title is the exact selection; its visible text may be a model nickname. */
const chip = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Choose model and reasoning effort' });

test('a model saved in a draft still reaches the first message in a newly chosen folder', async ({ page, launch }) => {
  const app: WebApp = await launch({ scripts: { hello: [{ text: 'reply' }] }, folders: ['second-folder'] });
  await openDraftChat(page, app);
  await chip(page).click();
  await page.getByRole('option', { name: /mock-beta/ }).click();
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-beta/);

  // Choosing another folder opens a fresh draft. Its picker falls back to the model
  // saved by the first pick; the first message must use that same model.
  await page.getByRole('button', { name: app.workspaceName, exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose a folder' })
    .getByRole('button', { name: 'Select second-folder' })
    .click();
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-beta/);

  await send(page, 'hello');
  await expectNoRunningTurn(page);
  await expect(turns(page)).toHaveCount(1);
  expect(app.model.turn('hello')[0]?.model).toBe('mock-beta');
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-beta/);
});
