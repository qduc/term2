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
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { call?: { id: string; command?: string; tool?: string; args?: object }; text?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[], withUsage = false): Promise<string> {
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
      const frames: unknown[] = reply.call
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
                        function: {
                          name: reply.call.tool ?? 'shell',
                          arguments: JSON.stringify(reply.call.args ?? { command: reply.call.command }),
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
            { id, choices: [{ delta: { role: 'assistant', content: reply.text } }] },
            { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
      if (withUsage) {
        frames.push({
          id,
          choices: [],
          usage: { prompt_tokens: 78021, completion_tokens: 731, prompt_tokens_details: { cached_tokens: 42112 } },
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

// The effective approval mode is visible without changing it.
async function runCommand(
  command: string,
  expected: string,
  firstPrompt?: string,
  exerciseMenu: false | 'complete' | 'prefix-enter' | 'pick-enter' | 'model-picker' = false,
  withUsage = false,
  expectedDraft?: string,
): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider([{ text: 'unused' }], withUsage);
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
      agent: {
        retryAttempts: 0,
        modelSelection: { model: 'mock-alpha', provider: 'mockprov' },
        favoriteModels: ['mockprov/mock-alpha'],
      },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      // Sandbox off and GREEN commands: both run without an approval prompt.
      sandbox: { enabled: false },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

  // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };

  if (firstPrompt) {
    await submit(firstPrompt);
    await session.waitForOutput('unused', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  }
  if (exerciseMenu === 'pick-enter') {
    // Arrow-picking a command and pressing Enter completes it into the draft; it must not run it.
    session.write('/us');
    await waitForHarnessComposerValue(idlePath, '/us', { timeoutMs: 60_000 });
    session.write('\x1b[B');
    session.write('\x1b[A');
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '/usage ', { timeoutMs: 60_000 });
    return;
  }
  if (exerciseMenu === 'prefix-enter') {
    // Enter on an unfinished prefix completes it into the draft; it must not run /clear.
    session.write('/cl');
    await waitForHarnessComposerValue(idlePath, '/cl', { timeoutMs: 60_000 });
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '/clear ', { timeoutMs: 60_000 });
    // The conversation is intact: the earlier prompt is still on screen and the app is still running.
    expect(session.getVisibleOutput()).toContain('keep this conversation');
    return;
  }
  if (exerciseMenu === 'complete') {
    session.write('/hel');
    await waitForHarnessComposerValue(idlePath, '/hel', { timeoutMs: 60_000 });
    await session.waitForOutput('/help', 30_000);
    // The menu says what each command does, from the same table /help prints.
    await session.waitForOutput('Show commands and keyboard shortcuts', 30_000);
    session.write('\t');
    await waitForHarnessComposerValue(idlePath, '/help ', { timeoutMs: 60_000 });
    session.write('\r');
    await session.waitForOutput('Keyboard shortcuts', 30_000);
  }
  await submit(command);
  await session.waitForOutput(expected, 30_000);
  if (expectedDraft !== undefined) await waitForHarnessComposerValue(idlePath, expectedDraft, { timeoutMs: 60_000 });
  if (exerciseMenu === 'model-picker') {
    await session.waitForOutput('mockprov/mock-alpha', 30_000);
    const beforeClose = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    session.write('\x1b');
    await waitForHarnessIdleGeneration(idlePath, { after: beforeClose, timeoutMs: 60_000 });
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    await submit('/model ');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    await session.waitForOutput('Choose a model', 30_000);
    const step = async (keys: string, expected: string) => {
      const offset = session!.getVisibleOutput().length;
      session!.write(keys);
      const started = Date.now();
      while (Date.now() - started < 30_000) {
        if (session!.getVisibleOutput().slice(offset).includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No new terminal output containing ${expected}: ${session!.getVisibleOutput().slice(-1200)}`);
    };
    await step('mock-alpha', 'Filter: mock-alpha');
    await step('\x06', 'No matching models.'); // Ctrl+F removes the favorite.
    await step('\t', '[All]');
    await session.waitForOutput('☆ mockprov/mock-alpha', 60_000);
    await step('\x06', '★ mockprov/mock-alpha'); // Re-add it on All.
    await step('\r', 'Model set to mockprov/mock-alpha.');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'));
    expect(settings.agent.favoriteModels).toContain('mockprov/mock-alpha');
  }
}

it('/auto-approve without an argument reports the current mode', { timeout: TIMEOUT_MS }, () =>
  runCommand('/auto-approve', 'Tool auto-approval is off.'),
);

it('/settings clears its submitted command', { timeout: TIMEOUT_MS }, () =>
  runCommand('/settings', 'shell.autoApproveMode: off (default)', undefined, false, false, ''),
);

it.each([
  ['/profile', 'Enter a name or full profile ID after /profile', '/profile '],
  ['/effort', 'Enter an effort after /effort in the input', '/effort '],
  ['/auto-approve', 'Enter a mode after /auto-approve in the input', '/auto-approve '],
])('%s explains its retained argument-entry draft', { timeout: TIMEOUT_MS }, (command, notice, draft) =>
  runCommand(command, notice, undefined, false, false, draft),
);

it(
  '/model picker filters, toggles favorites, selects a model and clears the composer',
  { timeout: TIMEOUT_MS },
  async () => {
    await runCommand('/model', 'Choose a model', undefined, 'model-picker');
  },
);

it('/model <provider>/<model> confirms the new model by name', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Model set to mockprov/mock-beta.'),
);

it('/resume ls labels each conversation with its time and first prompt', { timeout: TIMEOUT_MS }, async () => {
  await runCommand('/resume ls', 'conv_', 'tidy the workspace please');
  const visible = session!.getVisibleOutput();
  expect(visible).toMatch(/conv_[0-9a-f-]{36} {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}tidy the workspace/);
});

it('/usage agrees with the cached share in the status bar', { timeout: TIMEOUT_MS }, async () => {
  await runCommand('/usage', 'Token usage: 78,021 input (42,112 cached), 731 output', 'hello', false, true);
  expect(session!.getVisibleOutput()).toContain('54% cached');
});

it('/copy confirms what it copied', { timeout: TIMEOUT_MS }, () =>
  runCommand('/copy', 'Copied to clipboard.', 'say something'),
);

it('slash menu suggests and completes a command in the terminal', { timeout: TIMEOUT_MS }, () =>
  runCommand('/settings', 'shell.autoApproveMode: off (default)', undefined, 'complete'),
);

it('Enter on an unfinished slash prefix completes it and does not run the command', { timeout: TIMEOUT_MS }, () =>
  runCommand('/clear', '', 'keep this conversation', 'prefix-enter'),
);

it('Enter on an arrow-picked command completes it and does not run it', { timeout: TIMEOUT_MS }, () =>
  runCommand('/usage', '', undefined, 'pick-enter'),
);
