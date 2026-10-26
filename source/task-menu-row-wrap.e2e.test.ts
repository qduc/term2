import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, createTestChildEnv, type TerminalSession } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = path.join(projectRoot, 'dist', 'cli.js');
const TIMEOUT_MS = 120_000;
const COLS = 80;
const ROWS = 24;

let session: TerminalSession | null = null;
let server: http.Server | null = null;
let root = '';

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

async function startProvider(): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      requests += 1;
      const id = `chatcmpl-${requests}`;
      const frames =
        requests === 1
          ? [
              {
                id,
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'menu-row-shell',
                          type: 'function',
                          function: {
                            name: 'shell',
                            arguments: JSON.stringify({
                              command: "sleep 12; printf 'MENU_ROW_WRAP_FINISHED'; # MENU_ROW_WRAP_LABEL_0123456789",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [
              { id, choices: [{ delta: { role: 'assistant', content: 'background row test ready' } }] },
              { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
            ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

it(
  'renders a long live background task and its status on one row at an actual 80-column PTY',
  { timeout: TIMEOUT_MS },
  async () => {
    // Prove the PTY helper sets kernel geometry rather than relying on COLUMNS fallback.
    const geometry = spawnTerminal(
      'node',
      ['-e', 'process.stdout.write(`${process.stdout.columns}x${process.stdout.rows}`)'],
      {
        cols: COLS,
        rows: ROWS,
      },
    );
    expect((await geometry.waitForExit()).exitCode).toBe(0);
    expect(geometry.getVisibleOutput()).toContain(`${COLS}x${ROWS}`);

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-task-menu-row-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    fs.mkdirSync(runtime);
    const baseUrl = await startProvider();
    const idlePath = path.join(home, 'input-idle');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_RUNTIME_DIR: runtime,
      TERM2_CONFIG_DIR: path.join(home, '.term2'),
      TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
      TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
      DISABLE_LOGGING: '1',
      [HARNESS_IDLE_ENV]: idlePath,
      CI: 'false',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        sandbox: { enabled: false },
      }),
    );

    session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: COLS, rows: ROWS });
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    session.write('start a background shell task');
    await waitForHarnessComposerValue(idlePath, 'start a background shell task', { timeoutMs: 60_000 });
    session.write('\r');
    await session.waitForOutput('Agent wants to run: shell', 60_000);
    await session.waitForOutput('Allow once', 10_000);
    session.write('\r');
    await session.waitForOutput('Tasks · 1 active', 30_000);
    session.write('\x07');
    await session.waitForOutput('Manage background tasks', 30_000);
    session.write('b');
    await session.waitForOutput('Press Enter to put this shell in the background', 30_000);
    session.write('\r');
    await session.waitForOutput('Moved to background', 30_000);
    const menuStart = session.getVisibleOutput().lastIndexOf('Manage background tasks');
    const menu = session.getVisibleOutput().slice(menuStart);
    const taskRow = menu.split(/\r?\n/).find((line) => line.includes('[Shell]') && line.includes('sleep 12'));
    expect(taskRow, menu).toBeDefined();
    expect(taskRow, menu).toContain('active');
    await session.waitForOutput('MENU_ROW_WRAP_FINISHED', 30_000);

    await session.waitForOutput('background row test ready', 30_000);
    session.write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 100));
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);
