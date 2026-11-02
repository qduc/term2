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

type Reply = { error?: string; call?: { id: string; command?: string; tool?: string; args?: object }; text?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[], withUsage = false): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const reply = replies[requests++] ?? { text: 'done' };
      if (reply.error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', status: 400, error: { message: reply.error, code: 'model_not_found' } }),
        );
        return;
      }
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

it('dismisses a foreground approval to its numbered answer fallback', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-approval-fallback-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const marker = path.join(workspace, 'approved');
  const baseUrl = await startProvider([
    {
      call: {
        id: 'approval-call',
        command: `while [ ! -e '${home}' ]; do sleep 0.05; done; printf approved > '${marker}'`,
      },
    },
    { text: 'APPROVAL_FINISHED' },
  ]);
  const idlePath = path.join(home, 'input-idle');
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
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
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 100, rows: 30 });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  await submit('request approval');
  await session.waitForOutput('Allow once', 60_000);
  expect(session.getVisibleOutput()).not.toContain('/answer 1 <choice number>');
  session.write('\x07');
  await session.waitForOutput('/answer 1 <choice number>', 30_000);
  await submit('/answer 1 1');
  await session.waitForOutput('APPROVAL_FINISHED', 30_000);
  expect(fs.readFileSync(marker, 'utf8')).toBe('approved');
});

// The effective approval mode is visible without changing it.
async function runCommand(
  command: string,
  expected: string,
  firstPrompt?: string,
  exerciseMenu:
    | false
    | 'complete'
    | 'command-clear-regression'
    | 'prefix-enter'
    | 'pick-enter'
    | 'model-picker'
    | 'approval-shortcut'
    | 'approval-shortcut-history'
    | 'quit-hint' = false,
  withUsage = false,
  expectedDraft?: string,
  forbiddenOutput: readonly string[] = [],
  providerError?: string,
): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider([providerError ? { error: providerError } : { text: 'unused' }], withUsage);
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
    NODE_ENV: exerciseMenu && exerciseMenu.startsWith('approval-shortcut') ? 'production' : 'test',
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
        modelNicknames: { luna: 'mockprov/mock-alpha' },
      },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      // Sandbox off and GREEN commands: both run without an approval prompt.
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  const identity = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(builtCli), '../../../build-info.json'), 'utf8'),
  ) as {
    version: string;
    commit: string | null;
    release: boolean;
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
  if (identity.commit && !identity.release)
    expect(identity.version).toBe(`${manifest.version}-dev+${identity.commit.slice(0, 7)}`);
  await session.waitForOutput(`v${identity.version}`, 30_000);
  await session.waitForOutput('term²', 30_000);
  await session.waitForOutput('BARE', 30_000);
  await session.waitForOutput('mockprov', 30_000);
  await session.waitForOutput('mock-alpha', 30_000);

  // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };

  if (firstPrompt) {
    await submit(firstPrompt);
    await session.waitForOutput(providerError ?? 'unused', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  }
  if (exerciseMenu === 'command-clear-regression') {
    await submit('/help');
    await session.waitForOutput('/help —', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/rewind nonsense');
    await session.waitForOutput('Use /rewind', 30_000);
    await waitForHarnessComposerValue(idlePath, '/rewind nonsense', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/queue nonsense');
    await session.waitForOutput('Use /queue', 30_000);
    await waitForHarnessComposerValue(idlePath, '/queue nonsense', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/effort bogus');
    await session.waitForOutput('Unknown effort', 30_000);
    await waitForHarnessComposerValue(idlePath, '/effort bogus', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/not-a-real-command');
    await session.waitForOutput('/not-a-real-command is not available', 30_000);
    await waitForHarnessComposerValue(idlePath, '/not-a-real-command', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    session.write('/hel');
    await waitForHarnessComposerValue(idlePath, '/hel', { timeoutMs: 5_000 });
    session.write('\t');
    await waitForHarnessComposerValue(idlePath, '/help ', { timeoutMs: 5_000 });
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    return;
  }
  if (exerciseMenu === 'approval-shortcut-history') {
    session.write('\x1b[Z');
    await session.waitForOutput('Cannot switch modes mid-session', 30_000);
    expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8')).shell.autoApproveMode).toBe(
      'off',
    );
    return;
  }
  if (exerciseMenu === 'approval-shortcut') {
    session.write('draft stays');
    await waitForHarnessComposerValue(idlePath, 'draft stays', { timeoutMs: 60_000 });
    for (const mode of ['builtin:plan', 'builtin:bare']) {
      session.write('\x1b[Z');
      await session.waitForOutput(`Switched to ${mode} for this session.`, 30_000);
      await waitForHarnessComposerValue(idlePath, 'draft stays', { timeoutMs: 60_000 });
      expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8')).shell.autoApproveMode).toBe(
        'off',
      );
    }
    return;
  }
  if (exerciseMenu === 'quit-hint') {
    await submit('/quit');
    const exit = await session.waitForExit(30_000);
    expect(exit.exitCode).toBe(0);
    const output = session.getVisibleOutput();
    expect(output).toMatch(/To resume this conversation: term2-next --resume ['\"]?conv_[0-9a-f-]{36}/);
    return;
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
    await session.waitForOutput('/help —', 30_000);
  }
  await submit(command);
  await session.waitForOutput(expected, 30_000);
  for (const forbidden of forbiddenOutput) expect(session.getVisibleOutput()).not.toContain(forbidden);
  if (expectedDraft !== undefined) await waitForHarnessComposerValue(idlePath, expectedDraft, { timeoutMs: 60_000 });
  if (exerciseMenu === 'model-picker') {
    await session.waitForOutput('mockprov · aka luna', 30_000);
    expect(session.getVisibleOutput()).toContain('Provider / nickname');
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
    await step('luna', 'Filter: luna');
    expect(session.getVisibleOutput().slice(-1200)).toContain('mockprov · aka luna');
    await step('\x7f', 'Filter: lun');
    await step('\x7f', 'Filter: lu');
    await step('\x7f', 'Filter: l');
    await step('\x7f', 'Filter: ');
    await step('mock-alpha', 'Filter: mock-alpha');
    await step('\x06', 'No matching models.'); // Ctrl+F removes the favorite.
    await step('\t', '[All]');
    await session.waitForOutput('☆ mock-alpha', 60_000);
    await step('\x06', '★ mock-alpha'); // Re-add it on All.
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
  runCommand('/settings', 'Settings: models', undefined, false, false, ''),
);

it.each([
  ['/profile', 'Use /profile', ''],
  ['/effort', 'Use /effort', ''],
  ['/auto-approve', 'Use /auto-approve', ''],
])('%s explains its arguments and clears the composer', { timeout: TIMEOUT_MS }, (command, notice, draft) =>
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
  runCommand('/settings', 'Settings: models', undefined, 'complete'),
);

it('Enter on an unfinished slash prefix completes it and does not run the command', { timeout: TIMEOUT_MS }, () =>
  runCommand('/clear', '', 'keep this conversation', 'prefix-enter'),
);

it('Enter on an arrow-picked command completes it and does not run it', { timeout: TIMEOUT_MS }, () =>
  runCommand('/usage', '', undefined, 'pick-enter'),
);

it('Shift+Tab refuses a structural mode change with history without changing approval', async () => {
  await runCommand('', '', 'hello', 'approval-shortcut-history');
}, 120_000);

it('Shift+Tab toggles Plan and Bare without changing approval or draft', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'approval-shortcut'),
);

it('/providers lists the configured active provider', { timeout: TIMEOUT_MS }, () =>
  runCommand('/providers', 'mockprov (mockprov) — configured · active'),
);

it('/retry aliases retry-turn', { timeout: TIMEOUT_MS }, () => runCommand('/retry', 'No retained'));

it('invalid effort reports valid values without protocol internals', { timeout: TIMEOUT_MS }, () =>
  runCommand(
    '/effort ultra',
    "Unknown effort 'ultra'. Use: default, none, minimal, low, medium, high, xhigh.",
    undefined,
    false,
    false,
    undefined,
    ['invalid_command', 'Command '],
  ),
);

it('rejected model shows one human error without receipt internals', { timeout: TIMEOUT_MS }, () =>
  runCommand(
    '/model bogus/does-not-exist',
    "Provider 'bogus' is not registered",
    undefined,
    false,
    false,
    '/model bogus/does-not-exist',
    ['command_rejected', '· configure · rejected'],
  ),
);

it('successful configure does not leave a receipt in the activity view', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Model set to mockprov/mock-beta.', undefined, false, false, undefined, [
    '· configure · configured',
  ]),
);

it('quitting a conversation prints a usable resume hint', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', 'hello', 'quit-hint'),
);

it('rejects an unknown typed model', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/made-up-model', 'Unknown model mockprov/made-up-model. Current model unchanged.'),
);

it('shows a structured provider error as a message', { timeout: TIMEOUT_MS }, () =>
  runCommand(
    '/usage',
    'Token usage:',
    'hello',
    false,
    false,
    undefined,
    ['model_not_found'],
    'The selected model is not supported.',
  ),
);

it(
  'accepted commands clear, rejected commands remain, and Escape clears completed slash input',
  { timeout: TIMEOUT_MS },
  () => runCommand('', '', undefined, 'command-clear-regression'),
);
