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
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-path-completion-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'alpha.ts'), 'a');
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'n');
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.writeFileSync(path.join(workspace, 'node_modules', 'alphabet.js'), 'x');
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

it(
  '@ completes a workspace path: menu, Tab inserts without a space, Enter inserts with one',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start([{ text: 'done' }]);
    session!.write('look at @alp');
    await waitForHarnessComposerValue(idlePath, 'look at @alp', { timeoutMs: 60_000 });
    await session!.waitForOutput('src/alpha.ts', 30_000);
    // Ignored directories stay out of the list.
    expect(session!.getVisibleOutput()).not.toContain('alphabet.js');
    session!.write('\t');
    await until(() => composer(idlePath) === 'look at src/alpha.ts', 'Tab inserted the path without a space');
    session!.write(' and @not');
    await until(() => composer(idlePath) === 'look at src/alpha.ts and @not', 'typing continues');
    await session!.waitForOutput('notes.txt', 30_000);
    session!.write('\r');
    await until(
      () => composer(idlePath) === 'look at src/alpha.ts and notes.txt ',
      'Enter inserted the path and a space',
    );
  },
);

it('a directory keeps the menu open to continue inside it', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'done' }]);
  session!.write('@sr');
  await waitForHarnessComposerValue(idlePath, '@sr', { timeoutMs: 60_000 });
  await session!.waitForOutput('src/', 30_000);
  session!.write('\t');
  await until(() => composer(idlePath) === '@src/', 'the directory kept its @ and gained a slash');
  await session!.waitForOutput('src/alpha.ts', 30_000);
  session!.write('\r');
  await until(() => composer(idlePath) === 'src/alpha.ts ', 'the file replaced the @query');
});

it('Escape dismisses the path menu and Enter then sends the text as typed', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start([{ text: 'REPLY-DONE' }]);
  session!.write('see @alp');
  await waitForHarnessComposerValue(idlePath, 'see @alp', { timeoutMs: 60_000 });
  await session!.waitForOutput('src/alpha.ts', 30_000);
  session!.write('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 500));
  session!.write('\r');
  await session!.waitForOutput('REPLY-DONE', 30_000);
  const logged = fs
    .readdirSync(path.join(root, 'conversations'))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8'))
    .join('\n');
  expect(logged, 'the text was sent as typed, not replaced by a path').toContain('see @alp');
});

it('a draft ending in an ordinary @word is sent, not completed', { timeout: TIMEOUT_MS }, async () => {
  await start([{ text: 'REPLY-DONE' }]).then(async ({ idlePath }) => {
    session!.write('thanks @claude');
    await waitForHarnessComposerValue(idlePath, 'thanks @claude', { timeoutMs: 60_000 });
    session!.write('\r');
    await session!.waitForOutput('REPLY-DONE', 30_000);
  });
});
