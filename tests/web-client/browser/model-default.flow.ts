import { expect, type Page } from '@playwright/test';
import { expectNoRunningTurn, openDraftChat, send, test, turns } from './flow-helpers.js';
import type { WebApp } from './launch.js';

/** The chip's title is the exact selection; its visible text may be a model nickname. */
const chip = (page: Page) => page.getByRole('button', { name: 'Choose model and reasoning effort' });

async function pickFolder(page: Page, appFolder: string, name: string): Promise<void> {
  const browse = page.getByRole('button', { name: 'Browse' });
  if (await browse.count()) await browse.click();
  else await page.getByRole('button', { name: appFolder, exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose a folder' })
    .getByRole('button', { name: `Select ${name}` })
    .click();
}

async function pickBeta(page: Page): Promise<void> {
  await chip(page).click();
  await page.getByRole('option', { name: /mock-beta/ }).click();
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-beta/);
}

async function expectSentWith(page: Page, app: WebApp, prompt: string, model: string): Promise<void> {
  await expectNoRunningTurn(page);
  await expect(turns(page)).toHaveCount(1);
  const request = app.model.turn(prompt)[0];
  expect(request?.model).toBe(model);
  await expect(chip(page)).toHaveAttribute('title', new RegExp(`Model: ${model}`));
}

test('a model picked for a new folder reaches that folder’s first message', async ({ page, launch }) => {
  const app = await launch({ scripts: { hello: [{ text: 'reply' }] }, folders: ['second-folder'] });
  await openDraftChat(page, app);
  await pickFolder(page, app.workspaceName, 'second-folder');
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-alpha/);
  await pickBeta(page);
  await send(page, 'hello');
  await expectSentWith(page, app, 'hello', 'mock-beta');
});

test('a new folder after a model pick sends with the saved default model', async ({ page, launch }) => {
  const app = await launch({ scripts: { hello: [{ text: 'reply' }] }, folders: ['second-folder'] });
  await openDraftChat(page, app);
  await pickBeta(page);
  await pickFolder(page, app.workspaceName, 'second-folder');
  // The folder switch starts a fresh draft: its picker shows the saved default.
  await expect(chip(page)).toHaveAttribute('title', /Model: mock-beta/);
  await send(page, 'hello');
  await expectSentWith(page, app, 'hello', 'mock-beta');
});
