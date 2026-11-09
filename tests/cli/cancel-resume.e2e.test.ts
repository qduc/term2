import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
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
const EXIT_CONFIRM_WINDOW_MS = '300';
const EXIT_CONFIRM_WAIT_MS = 350;

/**
 * Every Ctrl+C arms the root's exit window. `handledBy` is a moment the test observed that Ctrl+C's effect
 * (so it was handled no later), and the window ends EXIT_CONFIRM_WINDOW_MS after handling: sleep only the rest.
 */
async function waitOutExitWindow(handledBy: number): Promise<void> {
  const remaining = handledBy + EXIT_CONFIRM_WAIT_MS - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type Reply = { text?: string; hang?: boolean; partialTool?: boolean };

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
      const frames: object[] = [{ id, choices: [{ delta: { role: 'assistant', content: reply.text } }] }];
      // Tool-call output already seen: a steer waits for the normal boundary instead of interrupting the stream.
      if (reply.partialTool) {
        const call = {
          index: 0,
          id: 'call_p',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"sl' },
        };
        frames.push({ id, choices: [{ delta: { tool_calls: [call] } }] });
      }
      if (!reply.hang) frames.push({ id, choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      // A hanging reply streams its text and then never finishes, like a long answer being cut short.
      if (reply.hang) res.write(`${body}\n`);
      else res.end(`${body}\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

it(
  'Ctrl+C stops a running turn and keeps the draft; later replies show after the stopped text, also after resume',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([
      { text: 'PARTIAL-ANSWER', hang: true },
      { text: 'SECOND-REPLY' },
      { text: 'THIRD-REPLY' },
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
      TERM2_EXIT_CONFIRM_WINDOW_MS: EXIT_CONFIRM_WINDOW_MS,
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

    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };
    const startCli = (args: string[]) => spawnTerminal('node', [builtCli, ...args], { cwd: workspace, env });
    session = startCli([]);
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('first question');
    await session.waitForOutput('PARTIAL-ANSWER', 60_000);
    // Legacy use-app-keyboard-shortcuts: Ctrl+C clears a draft first, even mid-turn; the next one stops the turn.
    session.write('half typed');
    await waitForHarnessComposerValue(idlePath, 'half typed', { timeoutMs: 30_000 });
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    // Every Ctrl+C arms the exit confirmation window, so the stopping one waits it out.
    await waitOutExitWindow(Date.now());
    // The live turn is not marked stopped at any point before the stopping key (checked last, over that whole span).
    const live = session.getVisibleOutput();
    const liveFrame = live.slice(live.lastIndexOf('▌ term²'));
    expect(liveFrame).toContain('PARTIAL-ANSWER');
    expect(liveFrame).not.toContain('Stopped');
    session.write('\x03');
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    await session.waitForOutput('Stopped', 30_000);
    const stoppedAt = Date.now();
    const stoppedOutput = session.getVisibleOutput();
    const stoppedFrame = stoppedOutput.slice(stoppedOutput.lastIndexOf('▌ term²'));
    expect(stoppedFrame).toContain('PARTIAL-ANSWER');
    expect(stoppedFrame.match(/Stopped/g)).toHaveLength(1);
    expect(stoppedFrame).not.toContain('Cancellation requested');
    expect(stoppedFrame).toMatch(/^ {0,8}Stopped\s*$/m);
    await send('second question');
    await session.waitForOutput('SECOND-REPLY', 30_000);
    let screen = session.getVisibleOutput();
    expect(screen.lastIndexOf('SECOND-REPLY'), 'the reply shows after the stopped partial text').toBeGreaterThan(
      screen.lastIndexOf('PARTIAL-ANSWER'),
    );
    // A further Ctrl+C inside the stopping one's window would exit at once instead of showing the hint.
    await waitOutExitWindow(stoppedAt);
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    await session.waitForExit(30_000);
    const id = fs
      .readdirSync(path.join(root, 'conversations'))
      .find((name) => name.endsWith('.jsonl'))!
      .replace('.jsonl', '');
    fs.rmSync(idlePath, { force: true });
    session = startCli(['--resume', id]);
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    expect(session.getVisibleOutput()).not.toContain('Previous turn was interrupted — send a message to continue.');
    await send('third question');
    await session.waitForOutput('THIRD-REPLY', 30_000);
    screen = session.getVisibleOutput();
    const resumedFrame = screen.slice(screen.lastIndexOf('▌ term²'));
    expect(resumedFrame.match(/Stopped/g)).toHaveLength(1);
    expect(screen.lastIndexOf('THIRD-REPLY'), 'a reply after resume shows after the stopped text').toBeGreaterThan(
      screen.lastIndexOf('PARTIAL-ANSWER'),
    );
  },
);

it('Esc stops a streaming answer without a turn-id cleanup notice', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider([
    { text: 'PARTIAL-ANSWER', hang: true },
    { text: 'SECOND-REPLY' },
    { text: 'THIRD-REPLY' },
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

  const send = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  const startCli = (args: string[]) => spawnTerminal('node', [builtCli, ...args], { cwd: workspace, env });
  session = startCli([]);
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  await send('first question');
  await session.waitForOutput('PARTIAL-ANSWER', 60_000);
  // Legacy interrupts with Esc twice.
  session.write('\x1b');
  await session.waitForOutput('Press Esc again to interrupt', 30_000);
  // The live turn is not marked stopped at any point before the stopping key (checked last, over that whole span).
  const live = session.getVisibleOutput();
  const liveFrame = live.slice(live.lastIndexOf('▌ term²'));
  expect(liveFrame).toContain('PARTIAL-ANSWER');
  expect(liveFrame).not.toContain('Stopped');
  session.write('\x1b');
  await session.waitForOutput('Stopped', 30_000);
  // The cancel notice asserted absent below would come from the cancel request's own reply, which nothing
  // published orders against the idle signal; 200 ms is ample for a local wire reply that already stopped the turn.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 30_000 });
  const output = session.getVisibleOutput();
  const frame = output.slice(output.lastIndexOf('▌ term²'));
  expect(frame).toContain('PARTIAL-ANSWER');
  expect(frame.match(/Stopped/g)).toHaveLength(1);
  expect(frame).not.toContain('Cancellation requested');
  expect(frame).not.toContain('cleanup may still be running');
});

it.each(['esc', 'ctrl-c', 'editing', 'only-steers'] as const)(
  'cancel %s drops queued steers and keeps follow-ups paused',
  { timeout: TIMEOUT_MS },
  async (mode) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-steer-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([
      { text: 'PARTIAL-ANSWER', hang: true, partialTool: true },
      { text: 'FOLLOWUP-REPLY' },
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
      TERM2_EXIT_CONFIRM_WINDOW_MS: EXIT_CONFIRM_WINDOW_MS,
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
    session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 30_000 });
      session!.write('\r');
    };
    await send('first question');
    await session.waitForOutput('PARTIAL-ANSWER', 60_000);
    if (mode !== 'only-steers') {
      session.write('UNIQUE-FOLLOWUP');
      await waitForHarnessComposerValue(idlePath, 'UNIQUE-FOLLOWUP', { timeoutMs: 30_000 });
      session.write('\x1b\r'); // Alt+Enter: queue a follow-up, not a steer.
      await session.waitForOutput('UNIQUE-FOLLOWUP', 30_000);
      await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
      // Queue projection can lead the send acknowledgement; avoid overlapping the next physical input.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await send('UNIQUE-QUEUED-STEER');
    await session.waitForOutput('steer · mid-turn', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await send('UNIQUE-SECOND-STEER');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    if (mode === 'editing') {
      // Legacy selects the first steer after the follow-up and second steer. An Up that lands before the
      // previous selection renders reaches the editor instead, so wait for each selection's marker.
      for (const selected of ['UNIQUE-FOLLOWUP', 'UNIQUE-SECOND-STEER', 'UNIQUE-QUEUED-STEER']) {
        const before = session.getVisibleOutput().length;
        session.write('\x1b[A');
        await expect
          .poll(() => session!.getVisibleOutput().slice(before), { timeout: 30_000 })
          .toMatch(new RegExp(`❯ ${selected}`));
      }
      session.write('e');
      await waitForHarnessComposerValue(idlePath, 'UNIQUE-QUEUED-STEER', { timeoutMs: 30_000 });
      session.write('-EDITED');
      await waitForHarnessComposerValue(idlePath, 'UNIQUE-QUEUED-STEER-EDITED', { timeoutMs: 30_000 });
    } else if (mode === 'ctrl-c') {
      session.write('EXISTING-DRAFT');
      await waitForHarnessComposerValue(idlePath, 'EXISTING-DRAFT', { timeoutMs: 30_000 });
    } else {
      // Legacy's first Esc asks to confirm the interrupt; the second (below) stops the turn.
      session.write('\x1b');
      await session.waitForOutput('Press Esc again to interrupt', 30_000);
    }
    if (mode === 'editing') {
      // Legacy's first Ctrl+C exits queue editing without cancelling the turn.
      const previousOutputLength = session.getVisibleOutput().length;
      session.write('\x03');
      await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
      // Observes that no stop follows. A wrongly cancelled turn would show Stopped once the abort reaches the
      // local fixture and back, well inside 500 ms; no signal marks that it will not come.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const screen = session.getVisibleOutput().slice(previousOutputLength);
      expect(screen).toContain('UNIQUE-QUEUED-STEER');
      expect(screen).toContain('UNIQUE-SECOND-STEER');
      expect(screen).not.toContain('Stopped');
      return;
    }
    if (mode === 'ctrl-c') {
      // Legacy's first Ctrl+C clears the draft; the second stops the turn.
      session.write('\x03');
      await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 5_000 });
      // That Ctrl+C armed the exit confirmation window; the stopping one waits it out.
      await waitOutExitWindow(Date.now());
    }
    const cancelAt = Date.now();
    session.write(mode === 'ctrl-c' ? '\x03' : '\x1b');
    // Legacy drops pending steers on cancellation (conversation-adapter's 'Pending submission was cancelled'):
    // no notice, and nothing comes back to the composer.
    await session.waitForOutput('Stopped', 5_000);
    expect(Date.now() - cancelAt).toBeLessThan(2_000);
    // The follow-up's hold is checked in the log below (no queue_started); it only runs after `r` in legacy's
    // paused-queue prompt.
    if (mode !== 'only-steers') await session.waitForOutput('Queue paused: 1 item pending.', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(Date.now() - cancelAt).toBeLessThan(2_000);
    expect(readHarnessComposerState(idlePath)?.value ?? '').toBe('');
    expect(session.getVisibleOutput()).not.toContain('back in the input');
    const log = fs.readFileSync(
      path.join(
        root,
        'conversations',
        fs.readdirSync(path.join(root, 'conversations')).find((name) => name.endsWith('.jsonl'))!,
      ),
      'utf8',
    );
    const facts = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).fact);
    const steers = facts.filter(
      (fact) => fact.type === 'queue_submitted' && fact.record?.request?.delivery === 'steer',
    );
    expect(steers).toHaveLength(2);
    const ids = steers.map((fact) => fact.record.messageId);
    expect(
      facts.some(
        (fact) => fact.type === 'queue_cancelling' && ids.every((id) => fact.cancelledMessageIds.includes(id)),
      ),
    ).toBe(true);
    expect(facts.some((fact) => fact.type === 'queue_started' && ids.includes(fact.messageId))).toBe(false);
    expect(facts.some((fact) => fact.type === 'turn_ended' && fact.outcome === 'cancelled')).toBe(true);
    const followup = facts.find(
      (fact) =>
        fact.type === 'queue_submitted' &&
        fact.record?.content?.some((part: { text?: string }) => part.text === 'UNIQUE-FOLLOWUP'),
    );
    if (mode === 'only-steers') {
      expect(followup).toBeUndefined();
      return;
    }
    expect(followup).toBeDefined();
    expect(facts.some((fact) => fact.type === 'queue_started' && fact.messageId === followup.record.messageId)).toBe(
      false,
    );
    session.write('r');
    await session.waitForOutput('FOLLOWUP-REPLY', 30_000);
  },
);

it.skipIf(process.platform !== 'linux')(
  'shows the continuation hint after resuming an interrupted turn',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([
      { text: 'PARTIAL-ANSWER', hang: true },
      { text: 'SECOND-REPLY' },
      { text: 'THIRD-REPLY' },
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

    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };
    const startCli = (args: string[]) => spawnTerminal('node', [builtCli, ...args], { cwd: workspace, env });
    session = startCli([]);
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('first question');
    await session.waitForOutput('PARTIAL-ANSWER', 60_000);
    // Kill the PTY child, not the bridge, to model an unclean process loss.
    const child = Number(
      fs.readFileSync(`/proc/${session.bridgePid}/task/${session.bridgePid}/children`, 'utf8').trim().split(/\s+/)[0],
    );
    expect(child).toBeGreaterThan(0);
    process.kill(child, 'SIGKILL');
    await session.waitForExit(30_000);
    const id = fs
      .readdirSync(path.join(root, 'conversations'))
      .find((name) => name.endsWith('.jsonl'))!
      .replace('.jsonl', '');
    fs.rmSync(idlePath, { force: true });
    session = startCli(['--resume', id]);
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await session.waitForOutput('Previous turn was interrupted — send a message to continue.', 30_000);
    await send('continue after interruption');
    await session.waitForOutput('SECOND-REPLY', 30_000);
  },
);

it.skipIf(process.platform !== 'linux')(
  'shows the continuation hint after resuming a cancelled turn',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([
      { text: 'PARTIAL-ANSWER', hang: true },
      { text: 'SECOND-REPLY' },
      { text: 'THIRD-REPLY' },
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
      TERM2_EXIT_CONFIRM_WINDOW_MS: EXIT_CONFIRM_WINDOW_MS,
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

    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };
    const startCli = (args: string[]) => spawnTerminal('node', [builtCli, ...args], { cwd: workspace, env });
    session = startCli([]);
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('first question');
    await session.waitForOutput('PARTIAL-ANSWER', 60_000);
    session.write('\x03');
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    await session.waitForOutput('Stopped', 30_000);
    // `/quit` exits by command, not by a second Ctrl+C, so the armed exit window does not matter.
    await send('/quit');
    await session.waitForExit(30_000);
    const id = fs
      .readdirSync(path.join(root, 'conversations'))
      .find((name) => name.endsWith('.jsonl'))!
      .replace('.jsonl', '');
    fs.rmSync(idlePath, { force: true });
    session = startCli(['--resume', id]);
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await session.waitForOutput('Previous turn was interrupted — send a message to continue.', 30_000);
    await send('continue after interruption');
    await session.waitForOutput('SECOND-REPLY', 30_000);
  },
);
