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
  readHarnessIdleGeneration,
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

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
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

it('browses bounded settings categories and changes a runtime setting', { timeout: TIMEOUT_MS }, async () => {
  const { idlePath } = await start();
  const submit = async (value: string) => {
    session!.write(value);
    await waitForHarnessComposerValue(idlePath, value, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  await submit('/settings');
  await session!.waitForOutput('Settings · [Models]', 60_000);
  expect(session!.getVisibleOutput()).toContain('Type search');
  const beforeClose = readHarnessIdleGeneration(idlePath);
  session!.write('\x1b');
  await waitForHarnessIdleGeneration(idlePath, { after: beforeClose, timeoutMs: 60_000 });
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
  expect(session!.getVisibleOutput()).not.toContain('agent.runBudget.softHeadroomUsdMicros');
  await submit('/settings providers');
  await session!.waitForOutput('Providers settings (1/', 60_000);
  expect(session!.getVisibleOutput()).toContain('webSearch.tavily.apiKey: [hidden]');
  expect(session!.getVisibleOutput()).not.toContain('SECRET_SENTINEL_987');
  await submit('/settings tools');
  await session!.waitForOutput('Tools settings (1/', 60_000);
  expect(session!.getVisibleOutput()).toContain('tools.shell.enabled');
  await submit('/settings tools 99');
  await session!.waitForOutput('Use /settings tools <page>', 60_000);
  await submit('/settings tools 2');
  await session!.waitForOutput('Tools settings (2/', 60_000);
  await submit('/settings tools.web.enabled false');
  await session!.waitForOutput('Set tools.web.enabled to false', 60_000);
  await submit('/settings tools.web.enabled');
  await session!.waitForOutput('tools.web.enabled: false', 60_000);
});

it.each([
  [80, 24],
  [60, 18],
])(
  'browses, searches and edits settings without leaking secrets or keys to composer at %ix%i',
  { timeout: TIMEOUT_MS },
  async (cols, rows) => {
    const { idlePath } = await start(cols, rows);
    const settingsFile = path.join(root, 'home', '.local', 'state', 'term2-nodejs', 'settings.json');
    const savedSettings = fs.readFileSync(settingsFile, 'utf8');
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };
    const fresh = async (action: () => void, needle: string) => {
      const offset = session!.getVisibleOutput().length;
      action();
      for (let i = 0; i < 400; i++) {
        const text = session!.getVisibleOutput().slice(offset);
        if (text.includes(needle)) return text;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No new output containing ${needle}: ${session!.getVisibleOutput().slice(-1800)}`);
    };
    await submit('/settings');
    await session!.waitForOutput('Settings · [Models]', 60_000);
    expect(session!.getVisibleOutput()).toContain('mockprov/mock-alpha');
    await fresh(() => session!.write('agent.runBudget.softHeadroomUsdMicros'), 'softHeadroomUsdMicros');
    await fresh(() => session!.write('\t'), '[Providers]');
    await fresh(() => session!.write('webSearch.tavily.apiKey'), 'Search: webSearch.tavily.apiKey');
    expect(session!.getVisibleOutput()).toContain('[hidden]');
    expect(session!.getVisibleOutput()).not.toContain('SECRET_SENTINEL_987');
    await fresh(() => session!.write('\r'), 'Sensitive: configure outside this editor.');
    const beforeCloseSecret = readHarnessIdleGeneration(idlePath);
    session!.write('\x1b');
    await waitForHarnessIdleGeneration(idlePath, { after: beforeCloseSecret, timeoutMs: 60_000 });
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    const reopenOffset = session!.getVisibleOutput().length;
    await submit('/settings');
    for (let i = 0; i < 400 && !session!.getVisibleOutput().slice(reopenOffset).includes('Settings · [Models]'); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session!.getVisibleOutput().slice(reopenOffset)).toContain('Settings · [Models]');
    await fresh(() => session!.write('tools.web.enabled'), 'Search: tools.web.enabled');
    await fresh(() => session!.write('\r'), 'Editing tools.web.enabled:');
    await fresh(() => session!.write('badvalue'), 'Editing tools.web.enabled: badvalue');
    const rejected = await fresh(() => session!.write('\r'), "Invalid value for 'tools.web.enabled'");
    expect(rejected).toContain('Editing tools.web.enabled: badvalue');
    await fresh(() => session!.write('\x1b'), 'Type search · Tab category');
    await fresh(() => session!.write('\r'), 'Editing tools.web.enabled:');
    await fresh(() => session!.write('false'), 'Editing tools.web.enabled: false');
    await fresh(() => session!.write('\r'), 'Set tools.web.enabled to false');
    await fresh(() => session!.write('\x1b'), 'Type search · Tab category');
    const beforeCloseEdit = readHarnessIdleGeneration(idlePath);
    session!.write('\x1b');
    await waitForHarnessIdleGeneration(idlePath, { after: beforeCloseEdit, timeoutMs: 60_000 });
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    await submit('/settings tools.web.enabled');
    await session!.waitForOutput('tools.web.enabled: false', 60_000);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(savedSettings);
  },
);
