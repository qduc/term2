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
      webSearch: { tavily: { apiKey: 'SECRET_SENTINEL_987' } },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
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
  await session!.waitForOutput('Settings: models', 60_000);
  expect(session!.getVisibleOutput()).toContain('Change: /settings <key> <value>');
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
