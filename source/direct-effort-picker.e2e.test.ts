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

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
let settingsPath = '';

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
  settingsPath = '';
});

async function start(): Promise<{ idlePath: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-effort-picker-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
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
    CI: 'false',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      ui: { skin: 'classic' },
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 100, rows: 35 });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  await session.waitForOutput('mockprov', 30_000);
  return { idlePath };
}

function storedEffort(): string | undefined {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).agent?.reasoningEffort;
}

/** Escape and the next command must not share one PTY read; wait until the close redraws. */
async function waitForRedraw(after: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (session!.getOutput().length > after) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the terminal to redraw');
}

/** Match text painted after `after`, so an earlier picker frame cannot satisfy the wait. */
async function waitForNewOutput(after: number, expected: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (session!.getOutput().slice(after).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No new terminal output containing ${expected}: ${session!.getVisibleOutput().slice(-800)}`);
}

it(
  'bare /effort opens the reasoning picker, applies a level, and Escape leaves it unchanged',
  { timeout: TIMEOUT_MS },
  async () => {
    const { idlePath } = await start();
    const before = storedEffort();
    session!.write('/effort');
    await waitForHarnessComposerValue(idlePath, '/effort', { timeoutMs: 30_000 });
    session!.write('\r');
    await session!.waitForOutput('Reasoning effort', 30_000);
    expect(session!.getVisibleOutput()).toContain('Use the model default');
    expect(session!.getOutput()).not.toContain('Use /effort default|none');
    const beforeClose = session!.getOutput().length;
    session!.write('\x1b');
    await waitForRedraw(beforeClose);
    const closed = await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    expect(session!.getOutput()).not.toContain('Reasoning effort set to');
    expect(storedEffort()).toBe(before);

    session!.write('/effort');
    await waitForHarnessComposerValue(idlePath, '/effort', { afterRevision: closed.revision, timeoutMs: 30_000 });
    const opened = session!.getOutput().length;
    session!.write('\r');
    await waitForNewOutput(opened, '❯ default');
    const up = async (marker: string) => {
      const at = session!.getOutput().length;
      session!.write('\x1b[A');
      await waitForNewOutput(at, marker);
    };
    await up('❯ xhigh');
    await up('❯ high');
    session!.write('\r');
    await session!.waitForOutput('Reasoning effort set to high.', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    expect(session!.getVisibleOutput()).toContain('mockprov/mock-alpha · high');
  },
);

it('Ctrl+T opens the same reasoning picker and Escape cancels', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  const before = storedEffort();
  session!.write('\x14');
  await session!.waitForOutput('Reasoning effort', 30_000);
  expect(session!.getVisibleOutput()).toContain('none');
  session!.write('\x1b');
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
  expect(session!.getOutput()).not.toContain('Reasoning effort set to');
  expect(storedEffort()).toBe(before);
});
