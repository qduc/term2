import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import { HARNESS_IDLE_ENV, waitForHarnessIdleGeneration } from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Built direct CLI. An idle composer matches the old CLI: the first Ctrl+C asks,
// the second within the confirm window exits 0, and an empty session prints no resume hint.
const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));

let session: TerminalSession | null = null;
let root = '';

afterEach(() => {
  session?.dispose();
  session = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

it('exits the idle direct composer on the second Ctrl+C', { timeout: 120_000 }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-ctrl-c-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  const idle = path.join(root, 'idle');
  fs.mkdirSync(workspace);
  const settingsEnv = createTestChildEnv({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: settingsEnv });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key' },
      ],
      sandbox: { enabled: false },
    }),
  );

  session = spawnTerminal('node', [cli, '--profile', 'bare'], {
    cwd: workspace,
    cols: 120,
    rows: 32,
    env: {
      ...settingsEnv,
      TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
      DISABLE_LOGGING: '1',
      CI: 'false',
      [HARNESS_IDLE_ENV]: idle,
    },
  });

  await session.waitForOutput('term²', 60_000);
  await waitForHarnessIdleGeneration(idle, { timeoutMs: 60_000 });
  session.write('\x03');
  await session.waitForOutput('Press Ctrl+C again to exit', 15_000);
  session.write('\x03');

  const exit = await session.waitForExit(15_000);
  expect(exit.exitCode).toBe(0);
  expect(exit.signal).toBeUndefined();
  const visible = session.getVisibleOutput();
  expect(visible).not.toContain('Session:');
  expect(visible).not.toContain('To resume this conversation:');
});
