import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { launchWebApp, type WebApp } from './launch.js';

/**
 * Browser flows for the web transcript: each one drives the built page against the real gateway and a
 * loopback model double, records the transcript the reader sees once the turn has settled, reloads the
 * page, and requires the same transcript again. "Works live, wrong after reload" is the defect class.
 *
 * If a reload comparison fails, the product shows two different transcripts for one conversation. Report
 * it; do not relax the comparison.
 */

const test = base.extend<{ launch: typeof launchWebApp }>({
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

const conversation = (page: Page): Locator => page.getByRole('log', { name: 'Conversation' });

/** One element per turn. A tool card is an `article` too, nested in its turn; it belongs to that turn. */
const turns = (page: Page): Locator => conversation(page).locator('article:not(article article)');

/**
 * What the reader is shown, turn by turn: the accessibility tree of each turn (text, tool rows, failure
 * notes and the per-message actions), in page order.
 */
async function transcript(page: Page): Promise<string[]> {
  return Promise.all((await turns(page).all()).map((turn) => turn.ariaSnapshot()));
}

/** Opens the page and picks the launch's folder, which leaves an unsent draft chat. */
async function openDraftChat(page: Page, app: WebApp): Promise<void> {
  await page.goto(app.origin);
  await page.getByRole('button', { name: 'Browse' }).click();
  await page
    .getByRole('dialog', { name: 'Choose a folder' })
    .getByRole('button', { name: 'Select flow-workspace' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
}

async function send(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message' }).fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
}

/** The composer offers Stop only while a turn runs; its absence is the page's own "turn over" signal. */
async function expectNoRunningTurn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Stop agent turn' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
}

async function sessionIds(page: Page, app: WebApp): Promise<string[]> {
  const response = await page.request.get(`${app.origin}/api/agent/sessions?limit=20`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { sessions: { id: string }[] };
  return body.sessions.map((session) => session.id);
}

/** Reloads, then requires the transcript recorded before the reload. */
async function expectSameTranscriptAfterReload(page: Page, before: string[]): Promise<void> {
  expect(before.length).toBeGreaterThan(0);
  await page.reload();
  await expect
    .poll(() => transcript(page), { message: 'transcript after reload must equal the one shown before it' })
    .toEqual(before);
  await expectNoRunningTurn(page);
  // Still equal once the reloaded page reports no running turn, not only at some moment while loading.
  expect(await transcript(page)).toEqual(before);
}

test('first send creates the chat, and its transcript survives a reload', async ({ page, launch }) => {
  const prompt = 'say the first flow reply';
  const reply = 'first flow reply from the model double';
  const app = await launch({ scripts: { [prompt]: [{ text: reply }] } });

  await openDraftChat(page, app);
  // A draft is not a chat yet: nothing is stored and the address names no session.
  expect(await sessionIds(page, app)).toEqual([]);
  expect(new URL(page.url()).searchParams.get('agentSession')).toBeNull();
  await expect(page.getByText('No chats yet')).toBeVisible();

  await send(page, prompt);
  const turn = turns(page).first();
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);

  // The first send created exactly one chat, and the page is now on it.
  await expect.poll(() => new URL(page.url()).searchParams.get('agentSession')).toMatch(/^conv_/);
  expect(await sessionIds(page, app)).toEqual([new URL(page.url()).searchParams.get('agentSession')]);
  await expect(page.getByText('No chats yet')).toHaveCount(0);

  // User bubble first, then the assistant's reply.
  await expect(turns(page)).toHaveCount(1);
  await expect(turn).toMatchAriaSnapshot(`
    - article:
      - paragraph: ${prompt}
      - button "Copy message"
      - paragraph: ${reply}
      - button "Copy reply"
  `);
  expect(app.model.turn(prompt)).toHaveLength(1);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  await expect(turns(page).first()).toContainText(reply);
  expect(app.model.unscripted()).toEqual([]);
});

test('a turn with a tool call shows the same tool row and reply after a reload', async ({ page, launch }) => {
  const prompt = 'read the notes file';
  const reply = 'The notes mention a quick brown fox.';
  const app = await launch({
    files: { 'notes.txt': 'the quick brown fox\n' },
    // read_file inside the workspace is read-only and needs no approval, so the turn runs unattended.
    scripts: { [prompt]: [{ call: { tool: 'read_file', args: { path: 'notes.txt' } } }, { text: reply }] },
  });

  await openDraftChat(page, app);
  await send(page, prompt);
  const turn = turns(page).first();
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);

  // The tool really ran: the model's second request carries the file's content as the tool result.
  const requests = app.model.turn(prompt);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.at(-1)).toMatchObject({
    role: 'tool',
    content: expect.stringContaining('the quick brown fox'),
  });

  // One tool row between the prompt and the reply.
  await expect(turns(page)).toHaveCount(1);
  await expect(turn).toMatchAriaSnapshot(`
    - article:
      - paragraph: ${prompt}
      - region "Tool calls":
        - button "Read 1 file"
      - paragraph: ${reply}
      - button "Copy reply"
  `);
  const collapsed = await transcript(page);

  // Opened, the row lists exactly one finished call; opened again, that call shows what it read.
  const toolCalls = turns(page).first().getByRole('region', { name: 'Tool calls' });
  const call = toolCalls.getByRole('article', { name: 'Tool read_file completed' });
  const openToolCall = async (): Promise<void> => {
    await toolCalls.getByRole('button', { name: 'Read 1 file' }).click();
    await expect(toolCalls.getByRole('article')).toHaveCount(1);
    await call.getByRole('button', { name: /notes\.txt/ }).click();
    await expect(call).toContainText('the quick brown fox');
  };
  await openToolCall();
  const opened = await transcript(page);

  await expectSameTranscriptAfterReload(page, collapsed);
  await openToolCall();
  expect(await transcript(page)).toEqual(opened);
  expect(app.model.unscripted()).toEqual([]);
});

test('a failed turn shows the provider error before and after a reload', async ({ page, launch }) => {
  const prompt = 'trigger the provider failure';
  const providerMessage = 'scripted provider failure 4711';
  const app = await launch({
    scripts: { [prompt]: [{ error: { status: 400, message: providerMessage } }] },
  });

  await openDraftChat(page, app);
  await send(page, prompt);
  const turn = turns(page).first();
  await expect(turn.getByText('Turn failed')).toBeVisible();
  await expectNoRunningTurn(page);

  await expect(turns(page)).toHaveCount(1);
  await expect(turn.getByRole('paragraph').first()).toHaveText(prompt);
  // The provider's own words, not a generic "could not reply".
  await expect(turn).toContainText(providerMessage);
  // A 400 is not retried: the provider saw the turn once.
  expect(app.model.turn(prompt)).toHaveLength(1);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  await expect(turns(page).first()).toContainText(providerMessage);
  await expect(turns(page).first().getByText('Turn failed')).toBeVisible();
  expect(app.model.unscripted()).toEqual([]);
});
