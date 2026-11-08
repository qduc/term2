import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dismissNoMatchSlashMenu,
  testCliPath,
  spawnTerminal,
  createTestChildEnv,
  type TerminalSession,
} from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;
const EXIT_CONFIRM_WINDOW_MS = '300';
const EXIT_CONFIRM_WAIT_MS = 350;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
let providerBodies: string[] = [];

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  providerBodies = [];
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type Reply = { error?: string; call?: { id: string; command?: string; tool?: string; args?: object }; text?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[], withUsage = false): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('failure')) {
      res.writeHead(500);
      res.end('provider unavailable');
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      providerBodies.push(body);
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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const serialized = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      res.write(`${serialized}\n`);
      if (withUsage) {
        const usage = {
          id,
          choices: [],
          usage: { prompt_tokens: 78_021, completion_tokens: 73, prompt_tokens_details: { cached_tokens: 42_112 } },
        };
        res.write(`data: ${JSON.stringify(usage)}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

async function runCommand(
  command: string,
  expected: string,
  firstPrompt?: string,
  exerciseMenu:
    | false
    | 'complete'
    | 'slash-picker-tab'
    | 'command-clear-regression'
    | 'prefix-enter'
    | 'pick-enter'
    | 'model-picker' = false,
  expectedDraft?: string,
  forbiddenOutput: readonly string[] = [],
): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-slash-cmd-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);

  const baseUrl = await startProvider([{ text: 'unused' }]);
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
    TERM2_EXIT_CONFIRM_WINDOW_MS: EXIT_CONFIRM_WINDOW_MS,
    [HARNESS_IDLE_ENV]: idlePath,
    CI: 'false',
    NODE_ENV: 'test',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      ui: { skin: 'classic' },
      agent: {
        retryAttempts: 0,
        modelSelection: { model: 'mock-alpha', provider: 'mockprov' },
        favoriteModels: ['mockprov/mock-alpha'],
        modelNicknames: { luna: 'mockprov/mock-alpha' },
      },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' },
        ...(exerciseMenu === 'model-picker'
          ? [{ name: 'brokenprov', type: 'openai-compatible', baseUrl: `${baseUrl}/failure`, apiKey: 'test-key' }]
          : []),
      ],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );

  session = spawnTerminal('node', [builtCli], {
    cwd: workspace,
    env,
    cols: exerciseMenu === 'model-picker' ? 100 : 80,
    ...(exerciseMenu === 'model-picker' ? { rows: 35 } : {}),
  });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

  const identity = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(builtCli), '../../build-info.json'), 'utf8'),
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

  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
    if (picked)
      await expect
        .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
        .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
    if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
    session!.write('\r');
  };

  if (firstPrompt) {
    await submit(firstPrompt);
    await session.waitForOutput('unused', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  }
  if (exerciseMenu === 'command-clear-regression') {
    await submit('/help');
    await session.waitForOutput('/help —', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/rewind nonsense');
    await session.waitForOutput('Unrecognised argument "nonsense"', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/queue nonsense');
    await session.waitForOutput('Unknown command /queue', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    await submit('/effort bogus');
    await session.waitForOutput('"bogus" is not one of the options', 30_000);
    await waitForHarnessComposerValue(idlePath, '/effort bogus', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, EXIT_CONFIRM_WAIT_MS));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    session.write('/not-a-real-command');
    await waitForHarnessComposerValue(idlePath, '/not-a-real-command', { timeoutMs: 60_000 });
    await dismissNoMatchSlashMenu(session, '/not-a-real-command');
    session.write('\r');
    await session.waitForOutput('Unknown command /not-a-real-command', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    session.write('/hel');
    await waitForHarnessComposerValue(idlePath, '/hel', { timeoutMs: 5_000 });
    session.write('\t');
    await waitForHarnessComposerValue(idlePath, '/help ', { timeoutMs: 5_000 });
    session.write('\x1b');
    await session.waitForOutput('Press Esc again to clear input', 5_000);
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    return;
  }
  if (exerciseMenu === 'slash-picker-tab') {
    session.write('/');
    await waitForHarnessComposerValue(idlePath, '/', { timeoutMs: 60_000 });
    await session.waitForOutput('Tab complete', 30_000);
    expect(session.getVisibleOutput()).toContain('╭');
    expect(session.getVisibleOutput()).toContain('Start a new conversation');
    session.write('mod');
    await waitForHarnessComposerValue(idlePath, '/mod', { timeoutMs: 60_000 });
    session.write('\r');
    await session.waitForOutput('Select model', 30_000);
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    session.write('/resu');
    await waitForHarnessComposerValue(idlePath, '/resu', { timeoutMs: 60_000 });
    session.write('\r');
    await session.waitForOutput('Resume Conversation', 30_000);
    return;
  }
  if (exerciseMenu === 'pick-enter') {
    session.write('/us');
    await waitForHarnessComposerValue(idlePath, '/us', { timeoutMs: 60_000 });
    session.write('\x1b[B');
    session.write('\x1b[A');
    session.write('\r');
    await session.waitForOutput('Token usage', 30_000);
    return;
  }
  if (exerciseMenu === 'prefix-enter') {
    const beforeClear = session.getOutput().length;
    session.write('/cl');
    await waitForHarnessComposerValue(idlePath, '/cl', { timeoutMs: 60_000 });
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    await vi.waitFor(() => expect(session!.getOutput().slice(beforeClear)).toContain('New conversation'), {
      timeout: 30_000,
    });
    return;
  }
  if (exerciseMenu === 'complete') {
    session.write('/hel');
    await waitForHarnessComposerValue(idlePath, '/hel', { timeoutMs: 60_000 });
    await session.waitForOutput('/help', 30_000);
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
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 60_000 });
    await session.waitForOutput('aka "luna"', 30_000);
    const picker = session.getVisibleOutput();
    expect(picker).toMatch(/mockprov\s+│/);
    expect(picker).not.toContain('mockpr…');
    expect(picker).toContain('Nicknames');
    expect(picker).toContain('(current)');
    expect(picker).toContain('ctrl+n nickname');

    let offset = session.getVisibleOutput().length;
    const step = async (keys: string, expected: string) => {
      offset = session!.getVisibleOutput().length;
      session!.write(keys);
      const started = Date.now();
      while (Date.now() - started < 30_000) {
        if (session!.getVisibleOutput().slice(offset).includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No new terminal output containing ${expected}: ${session!.getVisibleOutput().slice(-1200)}`);
    };
    await step('\t\t', 'Some providers failed: brokenprov');
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    // The prior picker is still in the terminal transcript. Wait for this opening's frame
    // before sending navigation, not just the composer value or an old menu heading.
    await step('/model ', 'Select model');
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 60_000 });
    await step('\x1b[B', '❯   mock-beta');
    await step('\x06', '❯ ★ mock-beta');
    await step('\x0e', 'Nickname for mock-beta:');
    await step('nova', 'Nickname for mock-beta: nova');
    await step('\r', '❯ ★ mock-beta — aka "nova"');
    await step('\x06', '❯   mock-beta — aka "nova"');
    await step('luna', 'Filter: luna');
    await session.waitForOutput('aka "luna"', 30_000);
    await step('\x7f', 'Filter: lun');
    await step('\x7f', 'Filter: lu');
    await step('\x7f', 'Filter: l');
    await step('\x7f', 'Filter:');
    await step('mock-alpha', 'Filter: mock-alpha');
    await step('\x06', '❯ mock-alpha — aka "luna"');
    await step('\t', 'No models match "mock-alpha"');
    await step('\t', 'aka "luna"');
    await step('\x06', '❯ ★ mock-alpha');
    await step('\r', 'Set model to mock-alpha (mockprov)');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'));
    expect(settings.agent.favoriteModels).toContain('mockprov/mock-alpha');
  }
}

it('/settings without an argument opens the legacy settings menu', { timeout: TIMEOUT_MS }, () =>
  runCommand('/settings', 'Tab section', undefined, false, '/settings '),
);

it('/profile without an argument opens the Profiles menu', { timeout: TIMEOUT_MS }, () =>
  runCommand('/profile', 'Currently active', undefined, false, '/profile '),
);

it(
  '/model picker filters, toggles favorites, selects a model and clears the composer',
  { timeout: TIMEOUT_MS },
  async () => {
    await runCommand('/model', 'Select model', undefined, 'model-picker');
  },
);

it('/model <provider>/<model> confirms the new model by name', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Set model to mock-beta (mockprov)'),
);

it('/copy confirms what it copied', { timeout: TIMEOUT_MS }, () =>
  runCommand('/copy', 'Copied the latest assistant response to the clipboard.', 'say something'),
);

it('slash menu suggests and completes a command in the terminal', { timeout: TIMEOUT_MS }, () =>
  runCommand('/settings', 'Tab section', undefined, 'complete'),
);

it('Enter on an unfinished slash prefix runs the command', { timeout: TIMEOUT_MS }, () =>
  runCommand('/clear', '', 'keep this conversation', 'prefix-enter'),
);

it('Enter on an arrow-picked command runs it', { timeout: TIMEOUT_MS }, () =>
  runCommand('/usage', '', undefined, 'pick-enter'),
);

it('/providers opens the legacy provider manager', { timeout: TIMEOUT_MS }, () =>
  runCommand('/providers', 'Your Providers', undefined, false, undefined, ['Configured providers:']),
);

it('/retry with no turn has nothing to rewind', { timeout: TIMEOUT_MS }, () =>
  runCommand('/retry', 'Nothing to rewind.'),
);

it('invalid effort is refused inline without protocol internals', { timeout: TIMEOUT_MS }, () =>
  runCommand('/effort bogus', '"bogus" is not one of the options', undefined, false, undefined, [
    'invalid_command',
    'Command ',
  ]),
);

it('a typed model no catalog lists is set as legacy did, without receipt internals', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model bogus/does-not-exist', 'Set model to bogus/does-not-exist (mockprov)', undefined, false, '', [
    'command_rejected',
    '· configure · rejected',
  ]),
);

it('successful configure does not leave a receipt in the activity view', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Set model to mock-beta (mockprov)', undefined, false, undefined, [
    '· configure · configured',
  ]),
);

it(
  'accepted and rejected slash commands clear, and double Escape clears completed slash input',
  { timeout: TIMEOUT_MS },
  () => runCommand('', '', undefined, 'command-clear-regression'),
);

it('Enter opens slash pickers and Escape returns to the composer', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'slash-picker-tab'),
);
