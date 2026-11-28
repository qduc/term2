// Local daemon launches through the built CLI (`TERM2_DAEMON_MODE=1` and `term2 daemon`). Every world
// isolates HOME, XDG and the runtime directory under its own temporary root; no case uses a shared
// directory such as /tmp itself as the conversations directory's parent.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  HARNESS_IDLE_ENV,
  readHarnessApprovalReady,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { integrationCliPath } from '../helpers/integration-cli.js';
import { spawnTerminal, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

let world: World | undefined;
let provider: LoopbackProvider | undefined;
let daemon: ChildProcess | undefined;
let terminal: TerminalSession | undefined;

afterEach(async () => {
  terminal?.dispose();
  terminal = undefined;
  daemon?.kill('SIGKILL');
  daemon = undefined;
  await provider?.close();
  provider = undefined;
  // Also stops any daemon advertised under the world's runtime directory.
  removeWorld(world);
  world = undefined;
});

async function prepare(
  settings: Record<string, unknown> = {},
  turns: Parameters<typeof startLoopbackProvider>[0]['turns'] = [],
) {
  world = createWorld('term2-daemon-launch');
  provider = await startLoopbackProvider({ turns, reviewer: { approve: true, reasoning: 'fixture approves' } });
  writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false }, ...settings });
  return world;
}

const cli = (env: NodeJS.ProcessEnv, args: string[]) => runCli({ ...world!, env }, integrationCliPath(), args);

it(
  'keeps a daemon for a TERM2_CONVERSATIONS_DIR store out of that directory’s parent',
  { timeout: 60_000 },
  async () => {
    const w = await prepare();
    // A parent other people use, like /tmp or a home directory, here inside the world's own root.
    const shared = path.join(w.root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    const env = { ...w.env, TERM2_CONVERSATIONS_DIR: path.join(shared, 'conversations') };

    daemon = spawn(process.execPath, [integrationCliPath(), 'daemon'], { env, cwd: w.workspace, stdio: 'ignore' });
    await expect
      .poll(async () => (await cli(env, ['daemon', 'status'])).status, { timeout: 20_000, interval: 100 })
      .toBe(0);

    // The daemon makes its state directory 0700 and keeps its lock there: never in the shared parent.
    expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(shared).filter((name) => name !== 'conversations')).toEqual([]);

    expect((await cli(env, ['daemon', 'stop'])).status).toBe(0);
    await expect.poll(() => daemon!.exitCode, { timeout: 10_000, interval: 50 }).not.toBeNull();
  },
);

const sockets = (root: string) =>
  fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('daemon.sock'));

it(
  'lets `term2 daemon status` and `stop` reach the daemon a headless run auto-started for the default store',
  { timeout: 60_000 },
  async () => {
    const w = await prepare({}, [{ text: 'DEFAULT-STORE-ANSWER' }]);
    // The default store: no TERM2_CONVERSATIONS_DIR, so HOME and XDG (inside the world) place it.
    const { TERM2_CONVERSATIONS_DIR: _store, ...rest } = w.env;
    const env = { ...rest, TERM2_DAEMON_MODE: '1' };

    const run = await cli(env, ['--profile', 'bare', 'Say something']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('DEFAULT-STORE-ANSWER');

    const status = await cli(env, ['daemon', 'status']);
    expect(status.status, status.stderr).toBe(0);
    const stop = await cli(env, ['daemon', 'stop']);
    expect(stop.status, stop.stderr).toBe(0);
    await expect.poll(() => sockets(path.join(w.root, 'runtime')), { timeout: 10_000, interval: 50 }).toEqual([]);
  },
);

it.each([
  ['over the daemon', { TERM2_DAEMON_MODE: '1' }],
  ['in-process', { TERM2_IN_PROCESS: '1' }],
])(
  'runs an unsandboxed shell command the person approves after the reviewer declines, in an auto-mode TUI, %s',
  { timeout: 90_000 },
  async (_mode, hostEnv) => {
    world = createWorld('term2-daemon-launch');
    const marker = path.join(world.workspace, 'approved.txt');
    provider = await startLoopbackProvider({
      turns: [
        { call: { tool: 'shell', args: { command: `echo approved > ${marker}`, sandbox: 'unsandboxed' } } },
        { text: 'MARKER-DONE' },
      ],
      reviewer: { approve: false, reasoning: 'fixture leaves it to the person' },
    });
    // With the sandbox on, `sandbox: 'unsandboxed'` asks to leave it: in auto mode the reviewer decides,
    // and declines here, so the person at the terminal is asked.
    writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: true }, shell: { autoApproveMode: 'auto' } });
    const idle = path.join(world.root, 'input-idle');
    terminal = spawnTerminal('node', [integrationCliPath(), '--profile', 'bare'], {
      cwd: world.workspace,
      env: { ...world.env, ...hostEnv, [HARNESS_IDLE_ENV]: idle, TERM2_EXIT_CONFIRM_WINDOW_MS: '300' },
    });
    await waitForHarnessIdleGeneration(idle, { timeoutMs: 30_000 });
    terminal.write('Write the marker');
    await waitForHarnessComposerValue(idle, 'Write the marker', { timeoutMs: 30_000 });
    terminal.write('\r');
    await terminal.waitForOutput('Manual approval required.', 30_000);
    await expect.poll(() => readHarnessApprovalReady(idle), { timeout: 30_000, interval: 20 }).not.toBeNull();
    terminal.write('\r');

    // The person's approval runs the command. The daemon's local surface used to take the web's
    // outside-sandbox path, whose execute step demands an `unsandboxed-once` grant that this prompt's
    // approval does not carry, so the approved command was refused.
    await terminal.waitForOutput('MARKER-DONE', 30_000);
    expect(provider.reviews()).toHaveLength(1);
    expect(JSON.stringify(provider.requests().at(-1)?.messages.at(-1))).not.toContain('outside-sandbox grant');
    expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null).toBe('approved\n');
    terminal.write('/quit\r');
    expect((await terminal.waitForExit(20_000)).exitCode).toBe(0);
  },
);
