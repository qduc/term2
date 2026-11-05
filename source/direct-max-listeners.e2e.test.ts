import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestChildEnv, spawnTerminal, testCliPath, type TerminalSession } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

// Built direct TUI. Opening the approval reason field mounts a second editor.
// That editor must not push stdout's resize listeners past Node's default of 10.
const cli = testCliPath(fileURLToPath(new URL('../dist/rewrite/src/app/cli.js', import.meta.url)));

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

it('opens an approval reason without a resize listener warning', { timeout: 120_000 }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-max-listeners-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  const idle = path.join(root, 'idle');
  fs.mkdirSync(workspace);
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    const id = 'chatcmpl-listeners';
    const frames = [
      {
        id,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-listeners',
                  type: 'function',
                  function: { name: 'shell', arguments: JSON.stringify({ command: "python3 -c 'print(1)'" }) },
                },
              ],
            },
          },
        ],
      },
      { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
  const settingsEnv = createTestChildEnv({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    [HARNESS_IDLE_ENV]: idle,
    CI: 'false',
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: settingsEnv });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      skin: 'classic',
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );
  session = spawnTerminal('node', [cli, '--profile', 'bare'], {
    cwd: workspace,
    env: settingsEnv,
    cols: 100,
    rows: 32,
  });
  await waitForHarnessIdleGeneration(idle, { timeoutMs: 60_000 });
  session.write('need a shell');
  await waitForHarnessComposerValue(idle, 'need a shell', { timeoutMs: 60_000 });
  session.write('\r');
  await session.waitForOutput('Allow once', 60_000);
  session.write('n');
  await session.waitForOutput('Why?', 30_000);
  expect(session.getOutput()).not.toContain('MaxListenersExceededWarning');
});
