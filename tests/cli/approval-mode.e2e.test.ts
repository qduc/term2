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
  readHarnessComposerState,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

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
      if (withUsage) {
        frames.push({
          id,
          choices: [],
          usage: {
            prompt_tokens: requests === 1 ? 78021 : 12345,
            completion_tokens: 731,
            prompt_tokens_details: { cached_tokens: requests === 1 ? 42112 : 0 },
          },
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (withUsage && !reply.call) {
        res.write(`data: ${JSON.stringify(frames[0])}\n\n`);
        setTimeout(
          () =>
            res.end(
              [...frames.slice(1).map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'),
            ),
          1700,
        );
      } else {
        res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

// Legacy's approval prompt owns input: Ctrl+G does nothing (there is no numbered /answer fallback) and the
// prompt itself approves the call.
it('Ctrl+G leaves a foreground approval on its prompt', { timeout: TIMEOUT_MS }, async () => {
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
    // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
    const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
    if (picked)
      await expect
        .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
        .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
    // Every provider's catalog lands in turn; let the list settle as a person reading it would.
    if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
    session!.write('\r');
  };
  await submit('request approval');
  await session.waitForOutput('Allow once', 60_000);
  session.write('\x07');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(session.getVisibleOutput()).toContain('Allow this action?');
  expect(session.getVisibleOutput()).not.toContain('/answer 1 <choice number>');
  session.write('\r');
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
    | 'hint-80'
    | 'hint-120'
    | 'skill-baseline'
    | 'skin-cards'
    | 'ctrl-u'
    | 'slash-picker-tab'
    | 'command-clear-regression'
    | 'prefix-enter'
    | 'pick-enter'
    | 'model-picker'
    | 'bare-clear-history'
    | 'quit-hint' = false,
  withUsage = false,
  expectedDraft?: string,
  forbiddenOutput: readonly string[] = [],
  providerError?: string,
  twoModels = false,
): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  if (exerciseMenu === 'skill-baseline') {
    const skillDir = path.join(workspace, '.agents', 'skills', 'dogfood');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: dogfood\ndescription: scratch dogfood skill\n---\nDOGFOOD_SKILL_SENTINEL\n',
    );
  }

  const baseUrl = await startProvider([providerError ? { error: providerError } : { text: 'unused' }], withUsage);
  const idlePath = path.join(home, 'input-idle');
  const env = {
    ...(exerciseMenu === 'ctrl-u' ? { TERM2_TEST_CURSOR_PATH: `${idlePath}.cursor` } : {}),
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
    NODE_ENV: 'test',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      ui: { skin: exerciseMenu === 'skin-cards' ? 'cards' : 'classic' },
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
      // Sandbox off and GREEN commands: both run without an approval prompt.
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
      // Pair is a dropped profile (#149), but one the settings already name still runs; leaving it is the one
      // switch out of a non-Bare profile that next can still make.
      ...(exerciseMenu === 'bare-clear-history' ? { app: { activeProfileId: 'builtin:pair' } } : {}),
    }),
  );

  session = spawnTerminal('node', [builtCli], {
    cwd: workspace,
    env,
    cols: exerciseMenu === 'hint-120' ? 120 : exerciseMenu === 'model-picker' ? 100 : 80,
    ...(exerciseMenu === 'model-picker' ? { rows: 35 } : {}),
  });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  if (exerciseMenu === 'hint-80' || exerciseMenu === 'hint-120') {
    const lines = session.getVisibleOutput().split('\n');
    const hintRows = lines.filter((row) => row.trimStart().startsWith('/ commands'));
    expect(hintRows).toHaveLength(1);
    // Legacy's last hint, `Shift+Tab plan`, named Plan mode: a dropped profile in next (#149).
    expect(hintRows[0]?.trimEnd()).toBe('  / commands │ @ paths │ ! shell');
    expect(lines.some((row) => row.startsWith(' output │'))).toBe(false);
    return;
  }

  if (exerciseMenu === 'skin-cards') {
    const visible = session.getVisibleOutput();
    expect(visible).toContain('╭');
    expect(visible).toContain('│ ❯');
    return;
  }
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
  await session.waitForOutput(exerciseMenu === 'bare-clear-history' ? 'PAIR' : 'BARE', 30_000);
  await session.waitForOutput('mockprov', 30_000);
  await session.waitForOutput('mock-alpha', 30_000);

  // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
    const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
    if (picked)
      await expect
        .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
        .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
    // Every provider's catalog lands in turn; let the list settle as a person reading it would.
    if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
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
    // Legacy's rewind command reports a bad argument and clears the input.
    await submit('/rewind nonsense');
    await session.waitForOutput('Unrecognised argument "nonsense"', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    // A command legacy does not have is refused by name, and the input clears.
    await submit('/queue nonsense');
    await session.waitForOutput('Unknown command /queue', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    // The /effort menu is open; legacy refuses an unknown level inline and keeps the text.
    await submit('/effort bogus');
    await session.waitForOutput('"bogus" is not one of the options', 30_000);
    await waitForHarnessComposerValue(idlePath, '/effort bogus', { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    // As in legacy, the first Enter closes the slash menu (no match) and the second submits.
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
    // Legacy: the first Escape only arms the clear; the second clears the draft.
    session.write('\x1b');
    await session.waitForOutput('Press Esc again to clear input', 5_000);
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
    return;
  }
  if (twoModels) {
    await submit('/model mockprov/mock-beta');
    await session.waitForOutput('Set model to mock-beta (mockprov)', 30_000);
    const before = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await submit('another question');
    await session.waitForOutput('done', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: before, timeoutMs: 60_000 });
    // Streamed text is not turn completion; wait for the second request's measured usage.
    await session.waitForOutput('Ctx 12k', 30_000);
  }
  if (exerciseMenu === 'ctrl-u') {
    // The cursor position settles asynchronously after each arrow key; pace Ctrl+U so it reads the settled cursor.
    session.write('abcXYZ');
    await waitForHarnessComposerValue(idlePath, 'abcXYZ', { timeoutMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      session.write('\x1b[D');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    session.write('\x15');
    await waitForHarnessComposerValue(idlePath, 'XYZ', { timeoutMs: 30_000 });
    const samples: { ms: number; state: ReturnType<typeof readHarnessComposerState>; cursor: string | null }[] = [];
    const started = Date.now();
    const sample = () => {
      const state = readHarnessComposerState(idlePath);
      let cursor: string | null = null;
      try {
        cursor = fs.readFileSync(`${idlePath}.cursor`, 'utf8');
      } catch {
        /* not published yet */
      }
      const last = samples.at(-1);
      if (!last || JSON.stringify([last.state, last.cursor]) !== JSON.stringify([state, cursor]))
        samples.push({ ms: Date.now() - started, state, cursor });
    };
    sample();
    const sampler = setInterval(sample, 10);
    try {
      session.write('Q');
      await waitForHarnessComposerValue(idlePath, 'QXYZ', { timeoutMs: 30_000 });
    } catch (error) {
      sample();
      throw new Error(
        `Ctrl+U composer acknowledgement failed; sampled timeline (10ms, intermediate revisions may be missed): ${JSON.stringify(
          samples,
        )}`,
        { cause: error },
      );
    } finally {
      clearInterval(sampler);
    }

    session.write('\x15');
    await waitForHarnessComposerValue(idlePath, 'XYZ', { timeoutMs: 30_000 });
    session.write('\x05');
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.write('\x15');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    session.write('first\nsecondXYZ');
    await waitForHarnessComposerValue(idlePath, 'first\nsecondXYZ', { timeoutMs: 30_000 });
    for (let i = 0; i < 3; i++) {
      session.write('\x1b[D');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    session.write('\x15');
    await waitForHarnessComposerValue(idlePath, 'first\nXYZ', { timeoutMs: 30_000 });
    // At buffer offset zero, Ctrl+U is a no-op.
    session.write('\x1b\\');
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.write('\x15');
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.write('Z');
    await waitForHarnessComposerValue(idlePath, 'Zfirst\nXYZ', { timeoutMs: 30_000 });
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
    // `/res` highlights /restart first in legacy's list; `/resu` leaves only /resume.
    session.write('/resu');
    await waitForHarnessComposerValue(idlePath, '/resu', { timeoutMs: 60_000 });
    session.write('\r');
    await session.waitForOutput('Resume Conversation', 30_000);
    return;
  }
  if (exerciseMenu === 'bare-clear-history') {
    // Legacy mode-commands: /bare with history asks before it clears, defaulting to No.
    let offset = session.getVisibleOutput().length;
    const since = () => session!.getVisibleOutput().slice(offset);
    const waitSince = async (predicate: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(predicate()).toBe(true);
    };
    await submit('/bare');
    await waitSince(() => since().includes('Clear session and switch to Bare mode?'));
    expect(since()).toContain('Switching to Bare mode requires clearing the current session.');
    await waitSince(() => since().includes('❯ No'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    offset = session.getVisibleOutput().length;
    session.write('\r');
    // Declining closes the prompt and keeps the profile.
    await waitSince(() => since().includes('/ commands'));
    expect(since()).not.toContain('Clear session and switch');
    expect(since()).toContain('Pair │');
    offset = session.getVisibleOutput().length;
    await submit('/bare');
    await waitSince(() => since().includes('❯ No'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    offset = session.getVisibleOutput().length;
    session.write('\x1b[A');
    await waitSince(() => since().includes('❯ Yes'));
    offset = session.getVisibleOutput().length;
    session.write('\r');
    await waitSince(() => since().includes('BARE'));
    // Confirming clears the conversation, then switches.
    expect(since()).not.toContain('hello');
    return;
  }
  if (exerciseMenu === 'quit-hint') {
    await submit('/quit');
    const exit = await session.waitForExit(30_000);
    expect(exit.exitCode).toBe(0);
    const output = session.getVisibleOutput();
    expect(output).toMatch(
      /To resume this conversation: term2 --resume [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\r?\n/,
    );
    return;
  }
  if (exerciseMenu === 'pick-enter') {
    // Enter executes the highlighted usage command.
    session.write('/us');
    await waitForHarnessComposerValue(idlePath, '/us', { timeoutMs: 60_000 });
    session.write('\x1b[B');
    session.write('\x1b[A');
    session.write('\r');
    await session.waitForOutput('Token usage', 30_000);
    return;
  }
  if (exerciseMenu === 'prefix-enter') {
    // Enter executes /clear, replacing the existing conversation.
    const beforeClear = session.getOutput().length;
    session.write('/cl');
    await waitForHarnessComposerValue(idlePath, '/cl', { timeoutMs: 60_000 });
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    // Legacy /clear prints the New conversation rule under the old transcript instead of clearing the screen.
    await vi.waitFor(() => expect(session!.getOutput().slice(beforeClear)).toContain('New conversation'), {
      timeout: 30_000,
    });

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
  if (exerciseMenu === 'skill-baseline') {
    // Legacy activates a skill from its menu; the next message carries it.
    await submit('/skills dogfood');
    await session.waitForOutput('Skill "dogfood" activated.', 30_000);
  }
  await submit(command);
  await session.waitForOutput(expected, 30_000);
  for (const forbidden of forbiddenOutput) expect(session.getVisibleOutput()).not.toContain(forbidden);
  if (expectedDraft !== undefined) await waitForHarnessComposerValue(idlePath, expectedDraft, { timeoutMs: 60_000 });
  if (exerciseMenu === 'skill-baseline') {
    expect(session.getVisibleOutput()).not.toContain('DOGFOOD_SKILL_SENTINEL');
    expect(session.getVisibleOutput()).toContain('[Skill: dogfood]');
    expect(session.getVisibleOutput()).toContain('SKILL-CHECK');
    expect(session.getVisibleOutput()).toContain('SECOND-LINE');
    expect(providerBodies.join('\n')).toContain('DOGFOOD_SKILL_SENTINEL');
    const directory = path.join(root, 'conversations');
    const file = fs.readdirSync(directory).find((name) => name.endsWith('.jsonl'))!;
    expect(fs.readFileSync(path.join(directory, file), 'utf8')).toContain('DOGFOOD_SKILL_SENTINEL');
    await submit('/quit');
    await session.waitForExit(30_000);
    session.dispose();
    fs.rmSync(idlePath, { force: true });
    session = spawnTerminal('node', [builtCli, '--resume', file.slice(0, -6)], { cwd: workspace, env });
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await session.waitForOutput('[Skill: dogfood]', 30_000);
    expect(session.getVisibleOutput()).toContain('SECOND-LINE');
    expect(session.getVisibleOutput()).not.toContain('DOGFOOD_SKILL_SENTINEL');
    const literal = '<system-notice>literal evidence</system-notice>';
    await submit(literal);
    await session.waitForOutput(literal, 30_000);
  }
  if (exerciseMenu === 'model-picker') {
    // Legacy `/model` puts `/model ` in the composer, which opens the model menu on its Favorites tab.
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 60_000 });
    await session.waitForOutput('aka "luna"', 30_000);
    // 100x35, same width as the spot check. The provider column must fit the whole name:
    // a short one such as "codex" was painting as "cod…" because the border took the last cell.
    const picker = session.getVisibleOutput();
    expect(picker).toMatch(/mockprov\s+│/);
    expect(picker).not.toContain('mockpr…');
    expect(picker).toContain('Nicknames');
    expect(picker).toContain('(current)');
    expect(picker).toContain('ctrl+n nickname');
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
    await step('\t\t', 'Some providers failed: brokenprov'); // The All tab lists every provider.
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    session.write('/model ');
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 60_000 });
    await session.waitForOutput('Select model', 30_000);
    await step('luna', 'Filter: luna');
    await session.waitForOutput('aka "luna"', 30_000);
    await step('\x7f', 'Filter: lun');
    await step('\x7f', 'Filter: lu');
    await step('\x7f', 'Filter: l');
    await step('\x7f', 'Filter:');
    await step('mock-alpha', 'Filter: mock-alpha');
    // The menu reopened on All: legacy keeps its selection hook, and so its tab, mounted between opens.
    await step('\x06', '❯ mock-alpha — aka "luna"'); // Ctrl+F removes the only favorite.
    await step('\t', 'No models match "mock-alpha"'); // All → Favorites, now empty.
    await step('\t', 'aka "luna"'); // Favorites → Nicknames, where the named model remains.
    await step('\x06', '❯ ★ mock-alpha'); // Re-add it.
    await step('\r', 'Set model to mock-alpha (mockprov)');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'));
    expect(settings.agent.favoriteModels).toContain('mockprov/mock-alpha');
  }
}

// Legacy's bare /auto-approve and /settings put their trigger in the composer, which opens the menu.
it('/auto-approve without an argument opens the legacy auto-approval menu', { timeout: TIMEOUT_MS }, () =>
  runCommand('/auto-approve', 'Shell auto-approval', undefined, false, false, '/auto-approve '),
);

it('/settings without an argument opens the legacy settings menu', { timeout: TIMEOUT_MS }, () =>
  runCommand('/settings', 'Tab section', undefined, false, false, '/settings '),
);

// Legacy's bare /profile puts its trigger back, which opens the Profiles menu.
it('/profile without an argument opens the Profiles menu', { timeout: TIMEOUT_MS }, () =>
  runCommand('/profile', 'Currently active', undefined, false, false, '/profile '),
);

it(
  '/model picker filters, toggles favorites, selects a model and clears the composer',
  { timeout: TIMEOUT_MS },
  async () => {
    await runCommand('/model', 'Select model', undefined, 'model-picker');
  },
);

// Typing `/model ` opens legacy's model menu; the rest of the line filters it and Enter picks the match.
it('/model <provider>/<model> confirms the new model by name', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Set model to mock-beta (mockprov)'),
);

it('/usage agrees with the cached share in the status bar', { timeout: TIMEOUT_MS }, async () => {
  await runCommand('/usage', 'Token usage: 78,021 input (42,112 cached), 731 output', 'hello', false, true);
  expect(session!.getVisibleOutput()).toContain('54% cached');
  expect(session!.getVisibleOutput()).toContain('Ctx 78k');
  expect(session!.getVisibleOutput()).toMatch(/\d+(?:\.\d+)?t\/s/);
  session!.write('/queue nonsense');
  await waitForHarnessComposerValue(path.join(root, 'home', 'input-idle'), '/queue nonsense', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('Unknown command /queue', 30_000);
  const visible = session!.getVisibleOutput();
  const afterNotice = visible.slice(visible.lastIndexOf('▌ term²'));
  expect(afterNotice).toContain('Token usage: 78,021 input (42,112 cached), 731 output');
  expect(afterNotice).toContain('By model:');
  expect(afterNotice).toContain('mockprov/mock-alpha:');
});

it('/usage separates actual model request usage', { timeout: TIMEOUT_MS }, async () => {
  await runCommand('/usage', 'Token usage: 90,366 input', 'hello', false, true, undefined, [], undefined, true);
  const visible = session!.getVisibleOutput();
  expect(visible).toContain('mockprov/mock-alpha:');
  expect(visible).toContain('mockprov/mock-beta:');
});

it('last-request context survives resume without becoming cumulative usage', { timeout: TIMEOUT_MS }, async () => {
  await runCommand('/usage', 'Token usage: 78,021 input', 'hello', false, true);
  const home = path.join(root, 'home');
  const idlePath = path.join(home, 'input-idle');
  session!.write('second request');
  await waitForHarnessComposerValue(idlePath, 'second request', { timeoutMs: 60_000 });
  session!.write('\r');
  await session!.waitForOutput('done', 30_000);
  await session!.waitForOutput('Ctx 12k', 30_000);
  session!.write('/quit');
  await waitForHarnessComposerValue(idlePath, '/quit', { timeoutMs: 60_000 });
  session!.write('\r');
  expect((await session!.waitForExit(30_000)).exitCode).toBe(0);
  const conversation = fs.readdirSync(path.join(root, 'conversations')).find((name) => name.endsWith('.jsonl'))!;
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    [HARNESS_IDLE_ENV]: idlePath,
    CI: 'false',
  };
  session = spawnTerminal('node', [builtCli, '--resume', conversation.slice(0, -6)], {
    cwd: path.join(root, 'w'),
    env,
  });
  await session.waitForOutput('Ctx 12k', 30_000);
  expect(session.getVisibleOutput()).not.toContain('Ctx 90k');
});

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

// /bare out of a settings-named Pair profile with history.
it('/bare confirms a clear before leaving a non-Bare profile with history', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', 'hello', 'bare-clear-history'),
);

it('/providers opens the legacy provider manager', { timeout: TIMEOUT_MS }, () =>
  runCommand('/providers', 'Your Providers', undefined, false, false, undefined, ['Configured providers:']),
);

// Legacy's /retry rewinds the last turn and resends it; with no turn there is nothing to rewind.
it('/retry with no turn has nothing to rewind', { timeout: TIMEOUT_MS }, () =>
  runCommand('/retry', 'Nothing to rewind.'),
);

// The /effort menu owns the Enter, so legacy refuses an unknown level inline and keeps the text.
it('invalid effort is refused inline without protocol internals', { timeout: TIMEOUT_MS }, () =>
  runCommand('/effort bogus', '"bogus" is not one of the options', undefined, false, false, undefined, [
    'invalid_command',
    'Command ',
  ]),
);

// No menu row matches, so legacy's menu submits the typed id on the current provider, unchecked, and clears the line.
it('a typed model no catalog lists is set as legacy did, without receipt internals', { timeout: TIMEOUT_MS }, () =>
  runCommand(
    '/model bogus/does-not-exist',
    'Set model to bogus/does-not-exist (mockprov)',
    undefined,
    false,
    false,
    '',
    ['command_rejected', '· configure · rejected'],
  ),
);

it('successful configure does not leave a receipt in the activity view', { timeout: TIMEOUT_MS }, () =>
  runCommand('/model mockprov/mock-beta', 'Set model to mock-beta (mockprov)', undefined, false, false, undefined, [
    '· configure · configured',
  ]),
);

it('quitting a conversation prints a usable resume hint', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', 'hello', 'quit-hint'),
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
  'accepted and rejected slash commands clear, and double Escape clears completed slash input',
  { timeout: TIMEOUT_MS },
  () => runCommand('', '', undefined, 'command-clear-regression'),
);

it('Enter opens slash pickers and Escape returns to the composer', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'slash-picker-tab'),
);

it('keeps composer hints on one row at 80 columns', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'hint-80'),
);
it('keeps all composer hints at 120 columns', { timeout: TIMEOUT_MS }, () => runCommand('', '', undefined, 'hint-120'));

it('uses the configured cards skin for the direct composer', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'skin-cards'),
);

it('displays the skill request without injected instructions', { timeout: TIMEOUT_MS }, () =>
  runCommand('SKILL-CHECK\nSECOND-LINE', 'unused', undefined, 'skill-baseline'),
);

it('Ctrl+U deletes only the current line before the cursor', { timeout: TIMEOUT_MS }, () =>
  runCommand('', '', undefined, 'ctrl-u'),
);
