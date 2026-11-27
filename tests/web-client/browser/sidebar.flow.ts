import { expect } from '@playwright/test';
import { expectNoRunningTurn, openDraftChat, send, test } from './flow-helpers.js';

/** The sidebar's running dot is read from the chat list, which must follow the session's live status. */
test('sidebar marks the running thread', async ({ page, launch }) => {
  const prompt = 'hold while the sidebar is checked';
  const reply = 'the held reply';
  const app = await launch({ scripts: { [prompt]: [{ text: reply, hold: 'sidebar-hold' }] } });
  const runningDot = page.locator('aside[aria-label="Chat history and folders"] [title="Running"]');

  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('sidebar-hold');
  await expect(page.getByRole('button', { name: 'Stop agent turn' })).toBeVisible();

  const response = await page.request.get(`${app.origin}/api/agent/sessions?limit=20`);
  expect(response.ok()).toBe(true);
  const sessions = (await response.json()) as { sessions: { status: string }[] };
  expect(sessions.sessions.map((session) => session.status)).toContain('running');

  // One chat appears in Recent and in its folder, so at least one dot must show while it runs.
  await expect.poll(() => runningDot.count()).toBeGreaterThan(0);

  app.model.release('sidebar-hold');
  await expectNoRunningTurn(page);
  await expect.poll(() => runningDot.count()).toBe(0);
});

test('sidebar pushes live status changes for a chat running in the background', async ({ page, launch }) => {
  const prompt = 'background chat status push';
  const reply = 'finished while another view is open';
  const app = await launch({ scripts: { [prompt]: [{ text: reply, hold: 'bg-sidebar-hold' }] } });
  const runningDot = page.locator('aside[aria-label="Chat history and folders"] [title="Running"]');

  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('bg-sidebar-hold');
  await expect.poll(() => runningDot.count()).toBeGreaterThan(0);

  // Leave the running chat for a new draft so it is no longer the open chat.
  await page
    .getByRole('button', { name: `New chat in ${app.workspaceName}` })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
  await expect.poll(() => runningDot.count()).toBeGreaterThan(0);

  // Release the background chat's turn: the session-list stream must clear its running dot live.
  app.model.release('bg-sidebar-hold');
  await expect.poll(() => runningDot.count()).toBe(0);
});
