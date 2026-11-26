/** Shared fixture and page helpers for the web browser flows (`*.flow.ts`). */
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { launchWebApp, type WebApp } from './launch.js';

export const test = base.extend<{ launch: typeof launchWebApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture names from this pattern.
  launch: async ({}, provide, testInfo) => {
    const apps: WebApp[] = [];
    await provide(async (options) => {
      const app = await launchWebApp(options);
      apps.push(app);
      return app;
    });
    for (const app of apps) {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('term2-web output', { body: app.output(), contentType: 'text/plain' });
      }
      await app.close();
    }
  },
});

export const conversation = (page: Page): Locator => page.getByRole('log', { name: 'Conversation' });

/** One element per turn. A tool card is an `article` too, nested in its turn; it belongs to that turn. */
export const turns = (page: Page): Locator => conversation(page).locator('article:not(article article)');

/**
 * What the reader is shown, turn by turn: the accessibility tree of each turn (text, tool rows, failure
 * notes and the per-message actions), in page order. All turns come from one snapshot of the
 * conversation, so the result is the page at one moment and never a mix of two renders.
 */
export async function transcript(page: Page): Promise<string[]> {
  // Before a chat is open (and while a reloaded page is still loading) there is no conversation region.
  if ((await conversation(page).count()) === 0) return [];
  const lines = (await conversation(page).ariaSnapshot()).split('\n');
  // The region's direct children sit at two spaces: the status line, one `article` per turn, the composer.
  const children: string[][] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('  - ')) children.push([]);
    children.at(-1)?.push(line.slice(2));
  }
  return children.filter((child) => child[0]!.startsWith('- article')).map((child) => child.join('\n'));
}

/** Opens the page and picks the launch's folder, which leaves an unsent draft chat. */
export async function openDraftChat(page: Page, app: WebApp): Promise<void> {
  await page.goto(app.origin);
  await page.getByRole('button', { name: 'Browse' }).click();
  await page
    .getByRole('dialog', { name: 'Choose a folder' })
    .getByRole('button', { name: `Select ${app.workspaceName}` })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
}

export async function send(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
}

/** The composer offers Stop only while a turn runs; its absence is the page's own "turn over" signal. */
export async function expectNoRunningTurn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Stop agent turn' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
}

export async function sessionIds(page: Page, app: WebApp): Promise<string[]> {
  const response = await page.request.get(`${app.origin}/api/agent/sessions?limit=20`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { sessions: { id: string }[] };
  return body.sessions.map((session) => session.id);
}

/** Reloads, then requires the transcript recorded before the reload. */
export async function expectSameTranscriptAfterReload(page: Page, before: string[]): Promise<void> {
  expect(before.length).toBeGreaterThan(0);
  await page.reload();
  await expect
    .poll(() => transcript(page), { message: 'transcript after reload must equal the one shown before it' })
    .toEqual(before);
  await expectNoRunningTurn(page);
  // Still equal once the reloaded page reports no running turn, not only at some moment while loading.
  expect(await transcript(page)).toEqual(before);
}
