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

const LONG_REASONING = Array.from(
  { length: 12 },
  (_, i) => `Step ${i + 1}: checking the workspace files and comparing the candidate implementation details.`,
).join('\n\n');

test('concise mode keeps the tool row and turn height stable across tool calls and completion', async ({
  page,
  launch,
}) => {
  const prompt = 'inspect two files concisely';
  const reply = 'Both files were read cleanly.';
  const app = await launch({
    files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
    scripts: {
      [prompt]: [
        { reasoning: LONG_REASONING, call: { tool: 'read_file', args: { path: 'a.txt' } }, hold: 'think-1' },
        { reasoning: LONG_REASONING, call: { tool: 'read_file', args: { path: 'b.txt' } }, hold: 'think-2' },
        { reasoning: LONG_REASONING, text: reply, hold: 'think-3' },
      ],
    },
  });

  await openDraftChat(page, app);
  await send(page, prompt);

  const turn = turns(page).first();
  const status = page.getByRole('log', { name: 'Conversation' }).locator('p[role="status"]');
  const turnHeight = () => turn.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const tailBottom = () =>
    page.getByRole('log', { name: 'Conversation' }).evaluate((log) => {
      const article = log.querySelector('article:not(article article)');
      const statusEl = log.querySelector('p[role="status"]');
      const a = article?.getBoundingClientRect().bottom ?? 0;
      const s = statusEl?.getBoundingClientRect().bottom ?? 0;
      return Math.round(Math.max(a, s));
    });

  await app.model.held('think-1');
  await expect(status).toContainText('Thinking…');
  await expect(turn.locator('details')).toHaveCount(0);
  const h1 = await turnHeight();

  // Watch every label the row takes between held steps: a pending tool must not replace the
  // settled work with a "waiting to start" line before the next call completes.
  await page.evaluate(() => {
    const w = window as unknown as { __toolLabels: string[] };
    w.__toolLabels = [];
    const article = document.querySelector('article:not(article article)');
    const record = () => {
      const labels = [...(article?.querySelectorAll('section[aria-label="Tool calls"] > button') ?? [])].map(
        (button) => button.textContent?.trim() ?? '',
      );
      if (labels.length > 0 && w.__toolLabels.at(-1) !== labels[0]) w.__toolLabels.push(labels[0]!);
      // The latest-call line under the row: '' while it is absent.
      const line = article?.querySelector('section[aria-label="Tool calls"] > p')?.textContent?.trim() ?? '';
      const cw = window as unknown as { __currentLines: string[] };
      if (cw.__currentLines.at(-1) !== line) cw.__currentLines.push(line);
    };
    (window as unknown as { __currentLines: string[] }).__currentLines = [];
    record();
    if (article) new MutationObserver(record).observe(article, { subtree: true, childList: true, characterData: true });
    // The status line is a fixed slot: while the turn runs it never goes blank or leaves the page.
    const sw = window as unknown as { __statusGaps: number };
    sw.__statusGaps = 0;
    const log = document.querySelector('[role="log"]');
    const watchStatus = () => {
      const line = log?.querySelector('p[role="status"]');
      if (!line || line.classList.contains('invisible') || !line.textContent?.trim()) sw.__statusGaps += 1;
    };
    if (log)
      new MutationObserver(watchStatus).observe(log, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
  });

  app.model.release('think-1');
  await app.model.held('think-2');
  await expect(turn.getByRole('button', { name: 'Read 1 file' })).toBeVisible();
  // The finished call stays named on its own line while the model thinks about the next one.
  const currentLine = turn.locator('section[aria-label="Tool calls"] > p');
  await expect(currentLine).toHaveText('Read a.txt');
  await expect(status).toContainText('Thinking…');
  await expect(turn.locator('details')).toHaveCount(0);
  const h2 = await turnHeight();
  expect(h2).toBeGreaterThanOrEqual(h1);

  app.model.release('think-2');
  await app.model.held('think-3');
  await expect(turn.getByRole('button', { name: 'Read 2 files' })).toBeVisible();
  await expect(turn).toContainText(reply);
  // The reply closed the run, so the latest-call line is gone.
  await expect(currentLine).toHaveCount(0);
  await expect(turn.locator('details')).toHaveCount(0);
  const h3 = await turnHeight();
  const bottomWhileStreaming = await tailBottom();
  expect(h3).toBeGreaterThanOrEqual(h2);
  await expect(status).toContainText('Writing…');
  expect(await page.evaluate(() => (window as unknown as { __statusGaps: number }).__statusGaps)).toBe(0);

  app.model.release('think-3');
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  const hDone = await turnHeight();
  const bottomWhenDone = await tailBottom();
  expect(hDone).toBeGreaterThanOrEqual(h3);
  // The reserved status tail matches the finished action bar height so completion does not bounce the layout.
  expect(bottomWhenDone).toBe(bottomWhileStreaming);
  const labels = await page.evaluate(() => (window as unknown as { __toolLabels: string[] }).__toolLabels);
  // The tally counts a call when it is issued, so it changes once per call and never names a
  // waiting or running call.
  expect(labels).toEqual(['Read 1 file', 'Read 2 files']);
  // Once shown, the latest-call line stays until the run ends: it never blinks out between calls.
  const lines = await page.evaluate(() => (window as unknown as { __currentLines: string[] }).__currentLines);
  const shown = lines.findIndex((line) => line !== '');
  expect(shown).toBeGreaterThanOrEqual(0);
  expect(lines.slice(shown, -1)).not.toContain('');
  expect(lines.at(-1)).toBe('');
  expect(lines).toContain('Read a.txt');
  expect(lines).toContain('Read b.txt');

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.unscripted()).toEqual([]);
});

test('standard mode keeps thinking blocks collapsed by default, preserves user-opened state, and keeps reply position stable', async ({
  page,
  launch,
}) => {
  const prompt = 'inspect two files in standard mode';
  const reply = 'Both files were read in standard mode.';
  const app = await launch({
    files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
    scripts: {
      [prompt]: [
        { reasoning: LONG_REASONING, call: { tool: 'read_file', args: { path: 'a.txt' } }, hold: 'think-1' },
        { reasoning: LONG_REASONING, call: { tool: 'read_file', args: { path: 'b.txt' } }, hold: 'think-2' },
        { reasoning: LONG_REASONING, text: reply, hold: 'think-3' },
      ],
    },
  });

  await openDraftChat(page, app);
  await page.evaluate(() => window.localStorage.setItem('term2.web.displayMode', 'standard'));
  await page.reload();
  await page
    .getByRole('button', { name: `New chat in ${app.workspaceName}` })
    .first()
    .click();
  await send(page, prompt);

  const turn = turns(page).first();
  const status = page.getByRole('log', { name: 'Conversation' }).locator('p[role="status"]');

  // Step 1 thinking: collapsed by default (no auto-expansion); the fixed status line still says what is happening.
  await app.model.held('think-1');
  const firstReasoning = turn.locator('details').first();
  await expect(firstReasoning.locator('summary')).toHaveText('Thinking…');
  expect(await firstReasoning.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await expect(status).toContainText('Thinking…');

  // If the reader explicitly opens a streaming thinking block, it stays open when accepted and scrolls in a bounded box.
  await firstReasoning.locator('summary').click();
  expect(await firstReasoning.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  const openedHeight = await firstReasoning.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(openedHeight).toBeLessThanOrEqual(340);

  app.model.release('think-1');
  await app.model.held('think-2');
  await expect(firstReasoning.locator('summary')).toHaveText('Thought process');
  expect(await firstReasoning.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
  // Step 2 thinking stays collapsed by default.
  const secondReasoning = turn.locator('details').nth(1);
  await expect(secondReasoning.locator('summary')).toHaveText('Thinking…');
  expect(await secondReasoning.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  const secondHeightWhileThinking = await secondReasoning.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height),
  );

  // Close the user-opened first reasoning block before checking reload parity.
  await firstReasoning.locator('summary').click();

  app.model.release('think-2');
  await app.model.held('think-3');
  await expect(secondReasoning.locator('summary')).toHaveText('Thought process');
  expect(await secondReasoning.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(
    secondHeightWhileThinking,
  );
  const replyParagraph = turn.getByText(reply);
  await expect(replyParagraph).toBeVisible();
  const replyTopWhileStreaming = await replyParagraph.evaluate((el) => Math.round(el.getBoundingClientRect().top));

  app.model.release('think-3');
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  // Accepting the third reasoning block must not teleport it from below the reply to above it.
  const replyTopWhenDone = await replyParagraph.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(replyTopWhenDone).toBe(replyTopWhileStreaming);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.unscripted()).toEqual([]);
});

const LONG_REPLY = Array.from({ length: 8 }, (_, i) => `Sentence ${i + 1} of a long reply arrives in one chunk.`).join(
  ' ',
);

/** Samples the reply paragraph every frame: how many characters it shows and the most fading spans it held. */
async function watchReply(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __replyLengths: number[]; __fadeSpans: number };
    w.__replyLengths = [];
    w.__fadeSpans = 0;
    const loop = () => {
      const reply = [...document.querySelectorAll('[role="log"] article .md-content p')].find((p) =>
        p.textContent?.startsWith('Sentence 1'),
      );
      if (reply) {
        const length = reply.textContent?.length ?? 0;
        if (w.__replyLengths.at(-1) !== length) w.__replyLengths.push(length);
        w.__fadeSpans = Math.max(w.__fadeSpans, reply.querySelectorAll('.t2-fade').length);
      }
      requestAnimationFrame(loop);
    };
    loop();
  });
}

async function replySamples(page: import('@playwright/test').Page): Promise<{ lengths: number[]; fadeSpans: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __replyLengths: number[]; __fadeSpans: number };
    return { lengths: w.__replyLengths, fadeSpans: w.__fadeSpans };
  });
}

test('a reply that arrives in one chunk is revealed at a steady pace with a fade, then settles to plain text', async ({
  page,
  launch,
}) => {
  const prompt = 'stream a long reply smoothly';
  const app = await launch({ scripts: { [prompt]: [{ text: LONG_REPLY, hold: 'long-reply' }] } });

  await openDraftChat(page, app);
  await watchReply(page);
  await send(page, prompt);
  await app.model.held('long-reply');
  const turn = turns(page).first();
  await expect(turn).toContainText(LONG_REPLY);

  // The whole reply arrived at once, but the page grew it over many frames, fading the newest text in.
  // The sampler reads the page once per frame; let it see the finished reply.
  await expect.poll(async () => (await replySamples(page)).lengths.at(-1)).toBe(LONG_REPLY.length);
  const { lengths, fadeSpans } = await replySamples(page);
  expect(lengths.length).toBeGreaterThan(10);
  expect(lengths[0]).toBeLessThan(LONG_REPLY.length / 4);
  expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  expect(fadeSpans).toBeGreaterThan(0);

  // Once the turn ends and the fade has run, the reply is plain markdown again.
  app.model.release('long-reply');
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await expect(turn.locator('.t2-fade')).toHaveCount(0);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.unscripted()).toEqual([]);
});

test('with reduced motion a streaming reply shows as it arrives, without pacing or fading', async ({
  page,
  launch,
}) => {
  const prompt = 'stream a long reply without motion';
  const app = await launch({ scripts: { [prompt]: [{ text: LONG_REPLY, hold: 'long-reply' }] } });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await openDraftChat(page, app);
  await watchReply(page);
  await send(page, prompt);
  await app.model.held('long-reply');
  const turn = turns(page).first();
  await expect(turn).toContainText(LONG_REPLY);

  // The sampler reads the page once per frame; let it see the finished reply.
  await expect.poll(async () => (await replySamples(page)).lengths.at(-1)).toBe(LONG_REPLY.length);
  const { lengths, fadeSpans } = await replySamples(page);
  expect(lengths).toEqual([LONG_REPLY.length]);
  expect(fadeSpans).toBe(0);

  app.model.release('long-reply');
  await expect(turn.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  expect(app.model.unscripted()).toEqual([]);
});

const SCROLL_ROOM = Array.from(
  { length: 30 },
  (_, i) => `Paragraph ${i + 1}: an earlier reply long enough that the conversation scrolls.`,
).join('\n\n');

/** The conversation's scroll offset and height, and where the newest reply's first line sits in the visible area. */
async function scrollState(
  page: import('@playwright/test').Page,
): Promise<{ top: number; height: number; replyOffset: number | null }> {
  return page.getByRole('log', { name: 'Conversation' }).evaluate((log) => {
    const scroller = log.querySelector('[data-turn-id]')?.closest('.overflow-y-auto') as HTMLElement | null;
    const starts = log.querySelectorAll('[data-reply-start]');
    const start = starts[starts.length - 1];
    return {
      top: Math.round(scroller?.scrollTop ?? -1),
      height: scroller?.clientHeight ?? 0,
      replyOffset:
        scroller && start ? Math.round(start.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null,
    };
  });
}

/** Scrolls the conversation to its very top with the mouse wheel, as a reader would. */
async function scrollToTop(page: import('@playwright/test').Page): Promise<void> {
  const box = (await page.getByRole('log', { name: 'Conversation' }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.wheel(0, -100_000);
  await expect.poll(async () => (await scrollState(page)).top).toBe(0);
}

test('a reply brings a reader who just sent into view, and leaves a reader who scrolled up afterwards where they are', async ({
  page,
  launch,
}) => {
  const first = 'give me a long answer to scroll through';
  const sentFromAbove = 'look at a.txt';
  const scrolledAway = 'look at b.txt while I read back';
  const app = await launch({
    files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' },
    scripts: {
      [first]: [{ text: SCROLL_ROOM }],
      [sentFromAbove]: [
        { call: { tool: 'read_file', args: { path: 'a.txt' } }, hold: 'sent-tool' },
        { text: 'The reader who sent from above sees this.', hold: 'sent-reply' },
      ],
      [scrolledAway]: [
        { call: { tool: 'read_file', args: { path: 'b.txt' } }, hold: 'away-tool' },
        { text: 'The reader who scrolled up is not pulled down to this.', hold: 'away-reply' },
      ],
    },
  });

  await openDraftChat(page, app);
  await send(page, first);
  await expect(turns(page).first()).toContainText('Paragraph 30');
  await expectNoRunningTurn(page);

  // Sending is asking for the answer: a reader who scrolled up and then sent is brought to the reply.
  await scrollToTop(page);
  await send(page, sentFromAbove);
  await app.model.held('sent-tool');
  app.model.release('sent-tool');
  await app.model.held('sent-reply');
  await expect(turns(page).nth(1)).toContainText('The reader who sent from above');
  await expect
    .poll(async () => {
      const { replyOffset, height } = await scrollState(page);
      return replyOffset !== null && replyOffset >= 0 && replyOffset < height;
    })
    .toBe(true);
  app.model.release('sent-reply');
  await expectNoRunningTurn(page);

  // Scrolling up after sending means reading something else: the first reply text must not move the view.
  await send(page, scrolledAway);
  await app.model.held('away-tool');
  await scrollToTop(page);
  app.model.release('away-tool');
  await app.model.held('away-reply');
  await expect(turns(page).nth(2)).toContainText('The reader who scrolled up');
  // Give the page a few frames to (wrongly) reposition before reading the offset.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await scrollState(page)).top).toBe(0);
  app.model.release('away-reply');
  await expectNoRunningTurn(page);
  expect((await scrollState(page)).top).toBe(0);

  await expectSameTranscriptAfterReload(page, await transcript(page));
  expect(app.model.unscripted()).toEqual([]);
});
