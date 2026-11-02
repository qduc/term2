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

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { text?: string; hang?: boolean };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const reply = replies[requests++] ?? { text: 'done' };
      const id = `chatcmpl-${requests}`;
      const frames: object[] = [{ id, choices: [{ delta: { role: 'assistant', content: reply.text } }] }];
      if (!reply.hang) frames.push({ id, choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      // A hanging reply streams its text and then never finishes, like a long answer being cut short.
      if (reply.hang) res.write(`${body}\n`);
      else res.end(`${body}\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

async function start(replies: Reply[]): Promise<{ idlePath: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider(replies);
  const idlePath = path.join(home, 'input-idle');
  const env = {
    HOME: home,
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
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
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
  const { idlePath } = await start([{ text: 'STREAMING-TEXT', hang: true }, { text: 'done' }]);
  session!.write('first question');
  await waitForHarnessComposerValue(idlePath, 'first question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('STREAMING-TEXT', 60_000);
  // A sender that writes text and CR together while the stream renders: the draft must be sent, not kept.
  session!.write('steer now\r');
  // The draft state is published after the commit, so give it time before reading it.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(composer(idlePath), 'the coalesced text+Enter was submitted and cleared the draft').toBe('');
  // The steer reached the durable log, so it was sent rather than dropped.
  const logs = fs.readdirSync(path.join(root, 'conversations')).filter((name) => name.endsWith('.jsonl'));
  expect(logs.map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8')).join('\n')).toContain(
    'steer now',
  );
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

it('a second message sent while the first is still being sent is not lost', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'STREAMING-TEXT', hang: true }, { text: 'done' }]);
  session!.write('first question');
  await waitForHarnessComposerValue(idlePath, 'first question', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('STREAMING-TEXT', 60_000);
  // Two messages a few milliseconds apart: the second arrives while the first send is in flight.
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
  expect(logged, 'the second steer reached the log').toContain('steer bravo');
});
