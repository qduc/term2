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
let heldResponse: http.ServerResponse | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
  heldResponse = null;
});

/** Keep the first provider response streaming until the test explicitly completes it. */
async function startProvider(): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      heldResponse = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ delta: { role: 'assistant', content: 'STREAM-ANCHOR-SENTINEL' } }],
        })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

async function start(): Promise<{ idlePath: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider();
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

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 250));
  expect(check(), what).toBe(true);
}

it('keeps live usage after the finalized response when its draft is replaced', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  await submit('first question');
  await session!.waitForOutput('STREAM-ANCHOR-SENTINEL', 30_000);
  await submit('/usage');
  await session!.waitForOutput('Token usage: 0 input', 30_000);
  expect(heldResponse).not.toBeNull();
  heldResponse!.end(
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
  );
  await session!.waitForOutput('STREAM-ANCHOR-SENTINEL', 30_000);
  await until(
    () =>
      fs
        .readdirSync(path.join(root, 'conversations'))
        .filter((f) => f.endsWith('.jsonl'))
        .some((f) => fs.readFileSync(path.join(root, 'conversations', f), 'utf8').includes('"type":"turn_ended"')),
    'turn settled',
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  // With native scrollback the settled response and the /usage output are committed once, in order, so compare the
  // last occurrences in the append-only output: the finalized response must precede the usage block.
  const output = session!.getVisibleOutput();
  expect(output).toContain('Token usage: 0 input');
  expect(output.lastIndexOf('Token usage: 0 input')).toBeGreaterThan(output.lastIndexOf('STREAM-ANCHOR-SENTINEL'));
});

it('wraps settled transcript rows at terminal width', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  const prompt = `PROMPT-START ${'alpha beta gamma delta epsilon zeta '.repeat(8)}PROMPT-END`;
  session!.write(prompt);
  await waitForHarnessComposerValue(idlePath, prompt, { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('STREAM-ANCHOR-SENTINEL', 30_000);
  heldResponse!.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      choices: [
        { delta: { content: '\nLine 00 bright harbor waves surround the old bell tower as the morning sun rises.' } },
      ],
    })}\n\n`,
  );
  heldResponse!.end(
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
  );
  await until(
    () =>
      fs
        .readdirSync(path.join(root, 'conversations'))
        .filter((f) => f.endsWith('.jsonl'))
        .some((f) => fs.readFileSync(path.join(root, 'conversations', f), 'utf8').includes('"type":"turn_ended"')),
    'turn settled',
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const output = session!.getVisibleOutput();
  const settled = output.slice(output.lastIndexOf('PROMPT-START'));
  expect(settled).toContain('PROMPT-END');
  expect(settled).toMatch(/morning sun\s*\r?\n\s*rises\./);
  expect(settled).not.toMatch(/morning sun ris\s*\r?\n\s*es\./);
});

it(
  'does not advertise the pager while streaming, and Ctrl+O mid-stream opens the model menu as in legacy',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start();
    session!.write('long streaming question');
    await waitForHarnessComposerValue(idlePath, 'long streaming question', { timeoutMs: 60_000 });
    session!.write('\r');
    await session!.waitForOutput('STREAM-ANCHOR-SENTINEL', 30_000);
    const before = session!.getVisibleOutput().length;
    heldResponse!.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ delta: { content: `\n${Array.from({ length: 60 }, (_, i) => `STREAM-LINE-${i}`).join('\n')}` } }],
      })}\n\n`,
    );
    await session!.waitForOutput('STREAM-LINE-59', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session!.getVisibleOutput().slice(before)).not.toMatch(/Lines \d+[–-]\d+ of \d+ · PgUp/);
    // Legacy has no output viewer: Ctrl+O replaces the draft with `/model ` and opens the model menu mid-stream.
    const ctrlOStart = session!.getVisibleOutput().length;
    session!.write('\x0f');
    await session!.waitForOutput('Select model', 30_000);
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 30_000 });
    expect(session!.getVisibleOutput().slice(ctrlOStart)).not.toMatch(/Lines \d+[–-]\d+ of \d+ · PgUp/);
    expect(heldResponse?.writableEnded).toBe(false);
  },
);

// While the turn is active, help retains the existing bounded viewer.
it('keeps paged help available during a still-streaming response', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  await submit('first question');
  await session!.waitForOutput('STREAM-ANCHOR-SENTINEL', 30_000);
  const before = session!.getVisibleOutput().length;
  await submit('/help');
  for (let i = 0; i < 400 && !session!.getVisibleOutput().slice(before).includes('Lines 1'); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  // Legacy's help text: the commands first, the keyboard shortcuts last.
  expect(session!.getVisibleOutput().slice(before)).toContain('/model — Choose or set the AI model');
  expect(session!.getVisibleOutput().slice(before)).toMatch(/Lines 1[–-]\d+ of \d+/);
  for (let i = 0; i < 12; i++) {
    session!.write('\x1b[6~');
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await session!.waitForOutput('Keyboard shortcuts', 30_000);
  expect(heldResponse?.writableEnded).toBe(false);
  heldResponse!.end(
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
  );
  await until(
    () =>
      fs
        .readdirSync(path.join(root, 'conversations'))
        .filter((f) => f.endsWith('.jsonl'))
        .some((f) => fs.readFileSync(path.join(root, 'conversations', f), 'utf8').includes('"type":"turn_ended"')),
    'the held turn settles after help',
  );
  const logs = fs.readdirSync(path.join(root, 'conversations')).filter((f) => f.endsWith('.jsonl'));
  expect(logs.map((f) => fs.readFileSync(path.join(root, 'conversations', f), 'utf8')).join('')).not.toContain(
    'Keyboard shortcuts',
  );
});
