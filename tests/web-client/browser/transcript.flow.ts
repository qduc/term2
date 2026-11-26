import { expect } from '@playwright/test';
import {
  expectNoRunningTurn,
  expectSameTranscriptAfterReload,
  openDraftChat,
  send,
  sessionIds,
  test,
  transcript,
  turns,
} from './flow-helpers.js';

/**
 * Browser flows for the web transcript: each one drives the built page against the real gateway and a
 * loopback model double, records the transcript the reader sees once the turn has settled, reloads the
 * page, and requires the same transcript again. "Works live, wrong after reload" is the defect class.
 *
 * If a reload comparison fails, the product shows two different transcripts for one conversation. Report
 * it; do not relax the comparison.
 */

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

test('retrying a failed turn clears its error once the retry succeeds', async ({ page, launch }) => {
  const prompt = 'fail once, then answer';
  const providerMessage = 'scripted provider failure 5821';
  const reply = 'the retry answered';
  const app = await launch({
    scripts: { [prompt]: [{ error: { status: 400, message: providerMessage } }, { text: reply }] },
  });

  await openDraftChat(page, app);
  await send(page, prompt);
  const turn = turns(page).first();
  await expect(turn).toContainText(providerMessage);
  await expectNoRunningTurn(page);

  await turn.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(turns(page).last()).toContainText(reply);
  await expectNoRunningTurn(page);
  expect(app.model.turn(prompt)).toHaveLength(2);

  // The failure the retry recovered from is no longer reported anywhere in the transcript.
  await expect(page.getByText(providerMessage)).toHaveCount(0);
  await expect(page.getByText('Turn failed')).toHaveCount(0);
  await expectSameTranscriptAfterReload(page, await transcript(page));
  await expect(page.getByText(providerMessage)).toHaveCount(0);
  expect(app.model.unscripted()).toEqual([]);
});

test('a tool waiting for approval shows the same prompt after a reload, and the approved turn too', async ({
  page,
  launch,
}) => {
  const prompt = 'run the approval command';
  const reply = 'The approved command printed its line.';
  const app = await launch({
    // An unsandboxed shell command always asks first, whether or not this machine can sandbox.
    scripts: {
      [prompt]: [
        {
          call: {
            tool: 'shell',
            args: { command: 'echo approved-by-flow', sandbox: 'unsandboxed', description: 'Print a line' },
          },
        },
        { text: reply },
      ],
    },
  });

  await openDraftChat(page, app);
  await send(page, prompt);
  const approval = page.getByRole('region', { name: 'Run this command?' });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('echo approved-by-flow');
  const waiting = await transcript(page);

  // While the tool waits for the user, a reload shows the same turn and the same question.
  await page.reload();
  await expect.poll(() => transcript(page)).toEqual(waiting);
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('echo approved-by-flow');

  // Approving from the reloaded page runs the command and the turn finishes.
  await approval.getByRole('button', { name: 'Run unsandboxed once' }).click();
  const turn = turns(page).first();
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await expect(approval).toHaveCount(0);
  const requests = app.model.turn(prompt);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.at(-1)).toMatchObject({
    role: 'tool',
    content: expect.stringContaining('approved-by-flow'),
  });
  await expect(turns(page)).toHaveCount(1);
  await expect(turn.getByRole('region', { name: 'Tool calls' })).toBeVisible();
  await expect(turn).toContainText(reply);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  await expect(page.getByRole('region', { name: 'Run this command?' })).toHaveCount(0);
  expect(app.model.unscripted()).toEqual([]);
});

test('a reload while a reply is streaming shows the same partial reply, then the same finished turn', async ({
  page,
  launch,
}) => {
  const prompt = 'start a slow reply';
  const partial = 'The first half of a slow reply';
  const app = await launch({ scripts: { [prompt]: [{ text: partial, hold: 'slow-reply' }] } });

  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('slow-reply');
  const turn = turns(page).first();
  await expect(turn).toContainText(partial);
  await expect(page.getByRole('button', { name: 'Stop agent turn' })).toBeVisible();
  const streaming = await transcript(page);

  // Mid-turn, a reload reconnects to the running turn: same partial reply, still running.
  await page.reload();
  await expect
    .poll(() => transcript(page), { message: 'a reload mid-turn must show the partial reply shown before it' })
    .toEqual(streaming);
  await expect(page.getByRole('button', { name: 'Stop agent turn' })).toBeVisible();

  // The reloaded page follows the turn to its end.
  app.model.release('slow-reply');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await expect(turns(page)).toHaveCount(1);
  await expect(turns(page).first()).toMatchAriaSnapshot(`
    - article:
      - paragraph: ${prompt}
      - button "Copy message"
      - button "Edit message"
      - paragraph: ${partial}
      - button "Copy reply"
      - button "Retry reply"
  `);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.turn(prompt)).toHaveLength(1);
  expect(app.model.unscripted()).toEqual([]);
});

test('a message steered into a running turn stays in that turn after a reload', async ({ page, launch }) => {
  const prompt = 'read the notes, slowly';
  const steer = 'also say how long the notes are';
  const reply = 'The notes are one short line.';
  const app = await launch({
    files: { 'notes.txt': 'hello notes\n' },
    scripts: {
      // The call is held, so the turn is running when the steer is sent; it reaches the model at the
      // next step, after the tool result, inside the same turn.
      [prompt]: [{ call: { tool: 'read_file', args: { path: 'notes.txt' } }, hold: 'before-tool' }],
      [steer]: [{ text: reply }],
    },
  });

  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('before-tool');
  await page.getByRole('textbox', { name: 'Message' }).fill(steer);
  await page.getByRole('button', { name: 'Steer' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: steer })).toBeVisible();

  app.model.release('before-tool');
  const turn = turns(page).first();
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);

  // One turn: prompt, the tool row, the steered message, then the reply.
  await expect(turns(page)).toHaveCount(1);
  await expect(turn).toMatchAriaSnapshot(`
    - article:
      - paragraph: ${prompt}
      - button "Copy message"
      - button "Edit message"
      - region "Tool calls":
        - button "Read 1 file"
      - paragraph: ${steer}
      - paragraph: ${reply}
      - button "Copy reply"
      - button "Retry reply"
  `);
  expect(app.model.turn(prompt)).toHaveLength(1);
  expect(app.model.turn(steer)).toHaveLength(1);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.unscripted()).toEqual([]);
});

test('per-reply token counts and the session total read the same before and after a reload', async ({
  page,
  launch,
}) => {
  const first = 'read the notes and count tokens';
  const second = 'say one more thing';
  const usage = { input: 1000, output: 234 }; // 1,234 tokens per provider request
  const app = await launch({
    files: { 'notes.txt': 'hello notes\n' },
    scripts: {
      [first]: [
        { call: { tool: 'read_file', args: { path: 'notes.txt' } }, usage },
        { text: 'Read them.', usage },
      ],
      [second]: [{ text: 'One more thing.', usage }],
    },
  });
  // The page loads a chat from its event stream alone: no separate hydration request.
  const hydrationReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^\/api\/agent\/sessions\/[^/]+$/u.test(url.pathname) && url.searchParams.has('format'))
      hydrationReads.push(request.url());
  });

  await openDraftChat(page, app);
  await send(page, first);
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await send(page, second);
  await expect(turns(page).nth(1).getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  expect(app.model.turn(first)).toHaveLength(2);
  expect(app.model.turn(second)).toHaveLength(1);

  // Each reply shows its turn's last reported usage; the chip shows the session's total of three requests.
  await expect(turns(page)).toHaveCount(2);
  for (const index of [0, 1]) await expect(turns(page).nth(index)).toContainText('1,234 tokens');
  const chip = page.getByRole('button', { name: 'Session usage and context' });
  await expect(chip).toContainText('3.7k tok');
  const before = await transcript(page);

  await expectSameTranscriptAfterReload(page, before);
  await expect(chip).toContainText('3.7k tok');
  expect(hydrationReads).toEqual([]);
  expect(app.model.unscripted()).toEqual([]);
});
