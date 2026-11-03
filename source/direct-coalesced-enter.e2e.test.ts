import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
  readHarnessComposerState,
  readHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
let received: string[] = [];
let closedHanging = false;

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  received = [];
  closedHanging = false;
});

type Reply = { text?: string; hang?: boolean; fail?: boolean; failMessage?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(body);
      const reply = replies[requests++] ?? { text: 'done' };
      if (reply.fail) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: reply.failMessage ?? 'retryable failure' } }));
        return;
      }
      const id = `chatcmpl-${requests}`;
      const frames: object[] = [{ id, choices: [{ delta: { role: 'assistant', content: reply.text } }] }];
      if (!reply.hang) frames.push({ id, choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      // A hanging reply streams its text and then never finishes, like a long answer being cut short.
      if (reply.hang) {
        res.on('close', () => {
          closedHanging = true;
        });
        res.write(`${wire}\n`);
      } else res.end(`${wire}\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

async function start(replies: Reply[], retryAttempts = 0, withSkill = false): Promise<{ idlePath: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  if (withSkill) {
    const skill = path.join(workspace, '.agents', 'skills', 'dogfood');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, 'SKILL.md'),
      '---\nname: dogfood\ndescription: scratch\n---\nQUEUE_SKILL_SENTINEL\n',
    );
  }
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'xclip'),
    `#!/usr/bin/env node\nprocess.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=', 'base64'));\n`,
    { mode: 0o755 },
  );
  const baseUrl = await startProvider(replies);
  const idlePath = path.join(home, 'input-idle');
  const env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    WAYLAND_DISPLAY: '',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    [HARNESS_IDLE_ENV]: idlePath,
    // Ink suppresses dynamic terminal updates in CI mode; this test needs an interactive TUI.
    CI: 'false',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      // Sandbox off and GREEN commands: both run without an approval prompt.
      sandbox: { enabled: false },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  return { idlePath };
}

const composer = (idlePath: string) => readHarnessComposerState(idlePath)?.value;
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  expect(check(), what).toBe(true);
}

it('text and Enter in one write submit while a turn is streaming', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'STREAMING-TEXT', hang: true }, { text: 'STEERED-REPLY' }]);
  session!.write('first question');
  await waitForHarnessComposerValue(idlePath, 'first question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('STREAMING-TEXT', 60_000);
  // A sender that writes text and CR together while the stream renders: the draft must be sent, not kept.
  session!.write('steer now\r');
  await session!.waitForOutput('STEERED-REPLY', 30_000);
  await until(() => received.length >= 2 && closedHanging, 'steer aborts the hanging response and dispatches another');
  expect(received[1]).toContain('steer now');
  expect(received[1]).toContain('STREAMING-TEXT');
  // The draft state is published after the commit.
  await until(() => composer(idlePath) === '', 'submitted steer clears the draft');
  expect(composer(idlePath), 'the coalesced text+Enter was submitted and cleared the draft').toBe('');
  // The steer reached the durable log, so it was sent rather than dropped.
  const logs = fs.readdirSync(path.join(root, 'conversations')).filter((name) => name.endsWith('.jsonl'));
  const log = logs.map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8')).join('\n');
  expect(log).toContain('steer now');
  const facts = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).fact);
  const partial = facts.findIndex((fact) => fact.type === 'item' && fact.item?.id?.endsWith('-partial'));
  const steer = facts.findIndex((fact) => fact.type === 'queue_steered');
  expect(partial, 'the interrupted text is finalized').toBeGreaterThanOrEqual(0);
  expect(steer, 'the steer is admitted after the partial is finalized').toBeGreaterThan(partial);
});

it('retries a steered turn after a dropped connection', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([
    { text: 'ORIGINAL-PARTIAL', hang: true },
    {
      fail: true,
      failMessage: 'WebSocket connection closed before a terminal response event. (code=1006 reason="" unsent=0)',
    },
    { text: 'RECOVERED-ANSWER' },
  ]);
  session!.write('original question');
  await waitForHarnessComposerValue(idlePath, 'original question', { timeoutMs: 30_000 });
  session!.write('\r');
  await session!.waitForOutput('ORIGINAL-PARTIAL', 60_000);
  session!.write('steer unique instruction');
  await waitForHarnessComposerValue(idlePath, 'steer unique instruction', { timeoutMs: 30_000 });
  session!.write('\r');
  await session!.waitForOutput('Connection to the model dropped.', 60_000);
  await session!.waitForOutput('/retry to try again.', 60_000);
  expect(session!.getVisibleOutput()).not.toContain('WebSocket connection closed before a terminal response event');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(received).toHaveLength(2);
  session!.write('/retry');
  await waitForHarnessComposerValue(idlePath, '/retry', { timeoutMs: 30_000 });
  session!.write('\r');
  await session!.waitForOutput('RECOVERED-ANSWER', 60_000);
  await until(() => received.length >= 3, 'retry request');
  expect(received[2]).toContain('steer unique instruction');
});

it(
  'a steer interrupts a retry response and the continued request reaches the provider',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start(
      [{ fail: true }, { text: 'RECOVERED-PARTIAL', hang: true }, { text: 'AFTER-RECOVERY-STEER' }],
      1,
    );
    session!.write('retry question');
    await waitForHarnessComposerValue(idlePath, 'retry question', { timeoutMs: 60_000 });
    session!.write('\r');
    await session!.waitForOutput('RECOVERED-PARTIAL', 60_000);
    session!.write('recovery steer\r');
    await session!.waitForOutput('AFTER-RECOVERY-STEER', 30_000);
    await until(() => received.length >= 3 && closedHanging, 'the recovery stream closes and the steer dispatches');
    expect(received[2]).toContain('recovery steer');
    expect(received[2]).toContain('RECOVERED-PARTIAL');
  },
);

it('retry redraw restores older static history while the new response streams', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([
    { text: `HISTORY-PREFIX-MARKER\n${Array.from({ length: 70 }, (_, i) => `old-line-${i}`).join('\n')}` },
    { fail: true },
    { text: 'RETRY-STREAMING', hang: true },
  ]);
  let idle = readHarnessIdleGeneration(idlePath);
  session!.write('earlier question');
  await waitForHarnessComposerValue(idlePath, 'earlier question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('HISTORY-PREFIX-MARKER', 60_000);
  idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  session!.write('question to retry');
  await waitForHarnessComposerValue(idlePath, 'question to retry', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('retryable failure', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  const before = session!.getOutput().length;
  session!.write('/retry-turn');
  await waitForHarnessComposerValue(idlePath, '/retry-turn', { timeoutMs: 30_000 });
  session!.write('\r');
  await session!.waitForOutput('RETRY-STREAMING', 60_000);
  const retryOutput = session!.getVisibleOutput();
  expect(retryOutput).not.toMatch(/Command [0-9a-f-]+ finished: retried/);
  expect(retryOutput).not.toMatch(/Command [0-9a-f-]+ · retry · retried/);
  const redraw = '\u001b[2J\u001b[3J\u001b[H';
  await until(() => session!.getOutput().slice(before).includes(redraw), 'retry redraw');
  const afterClear = session!.getOutput().slice(session!.getOutput().lastIndexOf(redraw));
  expect(afterClear).toContain('HISTORY-PREFIX-MARKER');
});

it('retry redraws after authoritative history replacement', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ fail: true }, { text: 'RETRY-REPLY' }]);
  const idle = readHarnessIdleGeneration(idlePath);
  session!.write('question to retry');
  await waitForHarnessComposerValue(idlePath, 'question to retry', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('retryable failure', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  const before = session!.getOutput().length;
  session!.write('/retry-turn');
  await waitForHarnessComposerValue(idlePath, '/retry-turn', { timeoutMs: 30_000 });
  session!.write('\r');
  await session!.waitForOutput('Conversation history restored to retry', 60_000);
  await until(() => received.length >= 2, 'retry dispatches a second model request');
  await session!.waitForOutput('RETRY-REPLY', 15_000);
  expect(session!.getOutput().slice(before)).toContain('\u001b[2J\u001b[3J\u001b[H');
});

it('rewind and clear redraw the terminal after successful history replacement', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'REWIND-REPLY' }]);
  const idle = readHarnessIdleGeneration(idlePath);
  session!.write('question to rewind');
  await waitForHarnessComposerValue(idlePath, 'question to rewind', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('REWIND-REPLY', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });

  const erase = '\u001b[2J\u001b[3J\u001b[H';
  const beforeRewind = session!.getOutput().length;
  session!.write('/rewind last');
  await waitForHarnessComposerValue(idlePath, '/rewind last', { timeoutMs: 30_000 });
  session!.write('\r');
  await waitForHarnessComposerValue(idlePath, 'question to rewind', { timeoutMs: 30_000 });
  expect(session!.getOutput().slice(beforeRewind)).toContain(erase);

  session!.write('\x03');
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
  const beforeClear = session!.getOutput().length;
  session!.write('/clear');
  await waitForHarnessComposerValue(idlePath, '/clear', { timeoutMs: 30_000 });
  session!.write('\r');
  await until(() => session!.getOutput().slice(beforeClear).includes(erase), 'clear redraws the terminal');
});

it('a bracketed paste keeps its Enter as a newline and does not submit', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'done' }]);
  session!.write('\x1b[200~pasted line\r\x1b[201~');
  await until(() => composer(idlePath) === 'pasted line\n', 'the pasted block stays in the draft with a newline');
});

it('a chunk with several lines (unbracketed paste) is not auto-submitted', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'done' }]);
  session!.write('one\rtwo\r');
  await until(() => composer(idlePath) === 'one\ntwo\n', 'the lines stay in the draft');
});

it(
  'text and Enter in one write after an existing draft send both and leave nothing behind',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start([{ text: 'REPLY-TO-ABCDEF' }]);
    session!.write('abc');
    await waitForHarnessComposerValue(idlePath, 'abc', { timeoutMs: 60_000 });
    session!.write('def\r');
    await session!.waitForOutput('REPLY-TO-ABCDEF', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(composer(idlePath), 'the old draft text was cleared with the send').toBe('');
    const logs = fs.readdirSync(path.join(root, 'conversations')).filter((name) => name.endsWith('.jsonl'));
    expect(logs.map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8')).join('\n')).toContain(
      'abcdef',
    );
  },
);

it('a second message sent while the first is still being sent is kept, not lost', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'STREAMING-TEXT', hang: true }, { text: 'done' }]);
  session!.write('first question');
  await waitForHarnessComposerValue(idlePath, 'first question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('STREAMING-TEXT', 60_000);
  // Two messages a few milliseconds apart: the second arrives while the first send may still be in flight.
  session!.write('steer alpha\r');
  await new Promise((resolve) => setTimeout(resolve, 15));
  session!.write('steer bravo\r');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const logged = fs
    .readdirSync(path.join(root, 'conversations'))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8'))
    .join('\n');
  expect(logged, 'the first steer reached the log').toContain('steer alpha');
  // The second one is either sent or still in the composer; it is never nowhere.
  const kept = logged.includes('steer bravo') || (composer(idlePath) ?? '').includes('steer bravo');
  expect(kept, 'the second steer is in the log or the draft').toBe(true);
});

it('marks an interrupted reply before the steer', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'PARTIAL-OLD-REPLY', hang: true }, { text: 'NEW-REPLY' }]);
  session!.write('first question');
  await waitForHarnessComposerValue(idlePath, 'first question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('PARTIAL-OLD-REPLY', 60_000);
  session!.write('STEER-PROMPT\r');
  await session!.waitForOutput('NEW-REPLY', 30_000);
  const visible = session!.getVisibleOutput();
  expect(visible.lastIndexOf('PARTIAL-OLD-REPLY')).toBeGreaterThanOrEqual(0);
  expect(visible.lastIndexOf('Stopped')).toBeGreaterThan(visible.lastIndexOf('PARTIAL-OLD-REPLY'));
  expect(visible.lastIndexOf('STEER-PROMPT')).toBeGreaterThan(visible.lastIndexOf('Stopped'));
  expect(visible.lastIndexOf('NEW-REPLY')).toBeGreaterThan(visible.lastIndexOf('STEER-PROMPT'));
});

it.skipIf(process.platform !== 'linux')(
  'edits a queued skill request without exposing or losing its body',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start(
      [{ text: 'PARTIAL-SKILL-QUEUE', hang: true }, { text: 'SKILL-QUEUE-REPLY' }],
      0,
      true,
    );
    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };
    await send('first question');
    await session!.waitForOutput('PARTIAL-SKILL-QUEUE', 60_000);
    await send('/skills dogfood queue request');
    await session!.waitForOutput('Queued 1 (queued): [Skill: dogfood]', 30_000);
    expect(session!.getVisibleOutput()).not.toContain('QUEUE_SKILL_SENTINEL');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await send('/queue edit 1');
    await waitForHarnessComposerValue(idlePath, 'queue request', { timeoutMs: 30_000 });
    expect(session!.getVisibleOutput()).not.toContain('QUEUE_SKILL_SENTINEL');
    session!.write('\x16');
    await session!.waitForOutput('[Pasted Image #1]', 30_000);
    expect(session!.getVisibleOutput()).not.toContain('QUEUE_SKILL_SENTINEL');
    // The editor re-renders after an image paste; keystrokes written during that remount are lost under load.
    await new Promise((resolve) => setTimeout(resolve, 600));
    session!.write('-EDITED');
    await until(() => composer(idlePath)?.includes('-EDITED') === true, 'edited request with pasted image');
    session!.write('\r');
    await session!.waitForOutput('Queued message updated.', 30_000);
    expect(session!.getVisibleOutput()).not.toContain('QUEUE_SKILL_SENTINEL');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await send('/queue edit 1 INLINE-EDIT');
    await session!.waitForOutput('INLINE-EDIT', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await send('/cancel');
    await session!.waitForOutput('Queue: paused', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await send('/queue resume');
    await session!.waitForOutput('SKILL-QUEUE-REPLY', 60_000);
    const visible = session!.getVisibleOutput();
    expect(visible).toContain('[Skill: dogfood]');
    expect(visible).toContain('INLINE-EDIT');
    expect(visible).not.toContain('QUEUE_SKILL_SENTINEL');
    expect(received.join('\n')).toContain('QUEUE_SKILL_SENTINEL');
    expect(received.join('\n')).toContain('INLINE-EDIT');
    expect(received.join('\n')).toContain('image/png');
  },
);

// Bare /undo must open the same picker and edit path as /rewind.
it('undo opens the rewind picker and restores the selected prompt for editing', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'UNDO-FIRST-REPLY' }, { text: 'UNDO-EDITED-REPLY' }]);
  const idle = readHarnessIdleGeneration(idlePath);
  session!.write('undo original question');
  await waitForHarnessComposerValue(idlePath, 'undo original question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('UNDO-FIRST-REPLY', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  session!.write('/undo');
  await waitForHarnessComposerValue(idlePath, '/undo', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('Choose a turn to rewind', 15_000);
  expect(session!.getVisibleOutput()).not.toContain('/undo is not available');
  session!.write('\r');
  await session!.waitForOutput('Edit in composer', 15_000);
  session!.write('\r');
  await session!.waitForOutput('Rewind draft restored', 30_000);
  await waitForHarnessComposerValue(idlePath, 'undo original question', { timeoutMs: 60_000 });
  expect(received).toHaveLength(1);
  session!.write(' edited');
  await waitForHarnessComposerValue(idlePath, 'undo original question edited', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('UNDO-EDITED-REPLY', 60_000);
  expect(received).toHaveLength(2);
  expect(received[1]).toContain('undo original question edited');
  const facts = fs
    .readdirSync(path.join(root, 'conversations'))
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(root, 'conversations', name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).fact),
    );
  expect(facts.some((fact) => fact.type === 'history_replaced' && fact.reason === 'rewind')).toBe(true);
});

it('undo accepts an explicit last target without auto-sending', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'UNDO-LAST-REPLY' }]);
  const idle = readHarnessIdleGeneration(idlePath);
  session!.write('explicit undo target');
  await waitForHarnessComposerValue(idlePath, 'explicit undo target', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('UNDO-LAST-REPLY', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  session!.write('/undo last');
  await waitForHarnessComposerValue(idlePath, '/undo last', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('Rewind draft restored', 30_000);
  await waitForHarnessComposerValue(idlePath, 'explicit undo target', { timeoutMs: 60_000 });
  expect(received).toHaveLength(1);
});
