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

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = path.join(projectRoot, 'dist', 'cli.js');
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { call?: { id: string; command: string }; text?: string };

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
      const frames = reply.call
        ? [
            {
              id,
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: reply.call.id,
                        type: 'function',
                        function: { name: 'shell', arguments: JSON.stringify({ command: reply.call.command }) },
                      },
                    ],
                  },
                },
              ],
            },
            { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { id, choices: [{ delta: { role: 'assistant', content: reply.text } }] },
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

// A provider that numbers calls per response sends `call_0` again in a later turn. That call runs, so
// its row must render, even though a row for the earlier `call_0` is already printed.
it('the terminal UI shows a later turn tool call that reuses an earlier call id', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const first = `echo one > ${path.join(workspace, 'one.txt')}`;
  const second = `echo two > ${path.join(workspace, 'two.txt')}`;
  const baseUrl = await startProvider([
    { call: { id: 'call_0', command: first } },
    { text: 'first turn done' },
    { call: { id: 'call_0', command: second } },
    { text: 'second turn done' },
  ]);
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
  let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

  // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };

  await submit('tidy the workspace');
  await session.waitForOutput('first turn done', 60_000);
  idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  const afterFirstTurn = session.getVisibleOutput().length;

  await submit('second turn');
  await session.waitForOutput('second turn done', 60_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  const secondTurnOutput = session.getVisibleOutput().slice(afterFirstTurn);

  // Quit the way a user does, so the app finishes its writes before the test removes its directories.
  session.write('\x03');
  await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
  session.write('\x03');
  expect((await session.waitForExit(30_000)).exitCode).toBe(0);

  // Both calls really ran...
  expect(fs.readFileSync(path.join(workspace, 'one.txt'), 'utf8')).toBe('one\n');
  expect(fs.readFileSync(path.join(workspace, 'two.txt'), 'utf8')).toBe('two\n');
  // ...so the second turn must render the second call's completed row.
  expect(secondTurnOutput, secondTurnOutput).toMatch(/✓ echo two > \S+two\.txt/);
});
