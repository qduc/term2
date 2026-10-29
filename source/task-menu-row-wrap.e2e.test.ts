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
let shellReleasePath = '';

afterEach(async () => {
  if (shellReleasePath) fs.writeFileSync(shellReleasePath, '');
  shellReleasePath = '';
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

async function startProvider(workspace: string): Promise<string> {
  let requests = 0;
  const command = (name: string) =>
    `while [ ! -e '${shellReleasePath}' ]; do sleep 0.05; done; printf '${name}' > '${path.join(
      workspace,
      `${name}.done`,
    )}'; # MENU_ROW_WRAP_LONG_LABEL_012345678901234567890123456789`;
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
      const tool =
        requests === 1 ? { name: 'one', background: true } : requests === 3 ? { name: 'two', background: false } : null;
      const frames = tool
        ? [
            {
              id,
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `menu-row-shell-${tool.name}`,
                        type: 'function',
                        function: {
                          name: 'shell',
                          arguments: JSON.stringify({ command: command(tool.name), background: tool.background }),
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
            {
              id,
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    content: requests === 2 ? 'first shell started' : 'second shell started',
                  },
                },
              ],
            },
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(30);
  }
  throw new Error(`Timed out: ${message}\n${currentMenu()}`);
}

function currentMenu(): string {
  const output = session?.getVisibleOutput() ?? '';
  return output.slice(output.lastIndexOf('Manage background tasks'));
}

function expectTwoActiveRows(menu: string): void {
  const rows = menu.split(/\r?\n/).filter((line) => line.includes('[Shell'));
  expect(rows, menu).toHaveLength(2);
  for (const row of rows) {
    expect(row, menu).toMatch(/· (?:running|active)\s*│$/);
    expect(Array.from(row).length, row).toBeLessThanOrEqual(COLS);
  }
  expect(
    menu.split(/\r?\n/).some((line) => /│\s*active\s*│/.test(line)),
    menu,
  ).toBe(false);
}

it(
  'keeps both active task statuses on-row through selection and transfer at an actual 80-column PTY',
  { timeout: TIMEOUT_MS },
  async () => {
    const geometry = spawnTerminal(
      'node',
      ['-e', 'process.stdout.write(`${process.stdout.columns}x${process.stdout.rows}`)'],
      { cols: COLS, rows: ROWS },
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
    shellReleasePath = path.join(workspace, 'release-shells');
    const baseUrl = await startProvider(workspace);
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
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text);
      session!.write('\r');
    };

    await submit('start first background shell');
    await session.waitForOutput('Allow once', 60_000);
    session.write('\r');
    await session.waitForOutput('first shell started', 30_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle });

    const beforeSecondApproval = session.getVisibleOutput().length;
    await submit('start second foreground shell');
    await waitUntil(
      () => session!.getVisibleOutput().slice(beforeSecondApproval).includes('Allow once'),
      'second shell approval prompt',
      60_000,
    );
    session.write('\r');
    await session.waitForOutput('Tasks · 2 active', 30_000);

    session.write('\x07');
    await session.waitForOutput('Manage background tasks', 30_000);
    await waitUntil(() => currentMenu().includes('❯ [Shell · foreground]'), 'foreground task selected');
    expectTwoActiveRows(currentMenu());

    session.write('\x1b[B');
    await waitUntil(() => currentMenu().includes('❯ [Shell]'), 'Down selects background task');
    expectTwoActiveRows(currentMenu());

    session.write('\r');
    await waitUntil(() => currentMenu().includes('ID:'), 'background task details open');
    session.write('\x1b[A');
    await waitUntil(() => currentMenu().includes('❯ [Shell · foreground]'), 'Up returns to foreground selection');
    expectTwoActiveRows(currentMenu());

    session.write('b');
    await session.waitForOutput('Press Enter to put this shell in the background', 30_000);
    session.write('\r');
    await session.waitForOutput('Moved to background', 30_000);
    await waitUntil(
      () =>
        currentMenu()
          .split(/\r?\n/)
          .filter((line) => line.includes('[Shell')).length === 2,
      'two background rows after transfer',
    );
    expectTwoActiveRows(currentMenu());
    expect(currentMenu()).not.toContain('[Shell · foreground]');

    fs.writeFileSync(shellReleasePath, '');
    const firstDone = path.join(workspace, 'one.done');
    const secondDone = path.join(workspace, 'two.done');
    await waitUntil(
      () => fs.existsSync(firstDone) && fs.existsSync(secondDone),
      'both shell side effects written',
      30_000,
    );
    expect(fs.readFileSync(firstDone, 'utf8')).toBe('one');
    expect(fs.readFileSync(secondDone, 'utf8')).toBe('two');
    await waitUntil(() => !currentMenu().includes('[Shell'), 'settled task rows removed', 30_000);
    expect(session.getVisibleOutput()).not.toContain('Task is no longer transferable');

    session.write('\x1b');
    await waitForHarnessIdleGeneration(idlePath, { after: idle });
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);
