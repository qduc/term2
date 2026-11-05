import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
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

async function startProvider(): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

async function start(cols = 80, rows = 24): Promise<{ idlePath: string }> {
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
      webSearch: { tavily: { apiKey: 'SECRET_SENTINEL_987' } },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols, rows });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  return { idlePath };
}

/** Write keys and wait for new output containing `needle`, so an earlier frame cannot satisfy the wait. */
async function fresh(action: () => void, needle: string): Promise<string> {
  const offset = session!.getVisibleOutput().length;
  action();
  for (let i = 0; i < 400; i++) {
    const text = session!.getVisibleOutput().slice(offset);
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No new output containing ${needle}: ${session!.getVisibleOutput().slice(-1800)}`);
}

/** Ink repaints only changed cells; poll the screen for `pattern` after `action`. */
async function screen(action: () => void, pattern: RegExp): Promise<void> {
  action();
  for (let i = 0; i < 400; i++) {
    if (pattern.test(session!.getVisibleOutput())) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Screen never matched ${pattern}: ${session!.getVisibleOutput().slice(-1800)}`);
}

it('bare /settings opens the legacy settings menu and Escape clears it', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  session!.write('/settings');
  await waitForHarnessComposerValue(idlePath, '/settings', { timeoutMs: 60_000 });
  session!.write('\r');
  // Legacy's action puts the trigger in the composer, which opens the menu.
  await waitForHarnessComposerValue(idlePath, '/settings ', { timeoutMs: 60_000 });
  await session!.waitForOutput('Tab section', 60_000);
  expect(session!.getVisibleOutput()).toContain('Providers');
  session!.write('\x1b');
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
});

it.each([
  [80, 24],
  [60, 18],
])(
  'searches, edits and toggles settings in the legacy menu without leaking secrets at %ix%i',
  { timeout: TIMEOUT_MS },
  async (cols, rows) => {
    const { idlePath } = await start(cols, rows);
    const settingsFile = path.join(root, 'home', '.local', 'state', 'term2-nodejs', 'settings.json');
    const savedSettings = fs.readFileSync(settingsFile, 'utf8');
    session!.write('/settings ');
    await waitForHarnessComposerValue(idlePath, '/settings ', { timeoutMs: 60_000 });
    await session!.waitForOutput('Tab section', 60_000);
    expect(session!.getVisibleOutput()).toContain('mockprov/mock-alpha');
    await fresh(() => session!.write('tavily'), 'Tavily API key');
    expect(session!.getVisibleOutput()).not.toContain('SECRET_SENTINEL_987');
    await fresh(() => session!.write('\r'), 'Type a value, then press Enter');
    expect(session!.getVisibleOutput()).not.toContain('SECRET_SENTINEL_987');
    await waitForHarnessComposerValue(idlePath, '/settings webSearch.tavily.apiKey ', { timeoutMs: 60_000 });
    // Esc from the value editor restores the list and its search.
    await fresh(() => session!.write('\x1b'), 'Searching all settings');
    await waitForHarnessComposerValue(idlePath, '/settings tavily', { timeoutMs: 60_000 });
    for (let i = 0; i < 'tavily'.length; i++) session!.write('\x7f');
    await waitForHarnessComposerValue(idlePath, '/settings ', { timeoutMs: 60_000 });

    // Booleans toggle in place.
    await fresh(() => session!.write('tools.web.enabled'), 'tools.web.enabled');
    await fresh(() => session!.write('\r'), '● OFF');

    // Enum editor: an unknown value is refused inline, then a choice applies and returns to the list.
    for (let i = 0; i < 'tools.web.enabled'.length; i++) session!.write('\x7f');
    await waitForHarnessComposerValue(idlePath, '/settings ', { timeoutMs: 60_000 });
    await fresh(() => session!.write('ui.displayMode'), 'Display mode');
    await screen(() => session!.write('\r'), /❯ (?:standard|concise)/);
    await fresh(() => session!.write('zzz'), 'zzz');
    await fresh(() => session!.write('\r'), '"zzz" is not one of the options');
    for (let i = 0; i < 3; i++) session!.write('\x7f');
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode ', { timeoutMs: 60_000 });
    session!.write('standard');
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode standard', { timeoutMs: 60_000 });
    // Applying closes the editor back to the list, which shows the new value.
    await screen(() => session!.write('\r'), /Display mode\s+(?:● )?standard/);
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode', { timeoutMs: 60_000 });

    session!.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    // These changes are session-only in this executable.
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(savedSettings);
  },
);
