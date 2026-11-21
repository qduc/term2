import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import {
  createWorld,
  processAlive,
  removeWorld,
  startLoopbackProvider,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));

let world: World | undefined;
let provider: LoopbackProvider | undefined;
let session: TerminalSession | null = null;
const leaked = new Set<number>();

afterEach(async () => {
  for (const pid of leaked) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  leaked.clear();
  session?.dispose();
  session = null;
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

// shell.backgroundTimeout: a background shell job is stopped when its deadline passes. Background jobs exist
// only in the interactive UI (headless sessions have no job registry), so this drives the built CLI in a
// pty against a loopback provider. The job's completion reaches the model as an automatic user-role
// notification, which is where "what the model is told" is read from.
//
// The commands only sleep and write marker files inside the test's workspace. Sandbox off and
// shell.autoApproveMode=always let the shell run without a prompt; neither touches the timeout.

async function runBackgroundJob(options: {
  command: string;
  settings: { timeout?: number; backgroundTimeout: number };
  names: string[];
}) {
  world = createWorld('term2-bg-timeout');
  const w = world;
  const idlePath = path.join(w.home, 'input-idle');
  const pids: Record<string, number> = {};
  let aliveWhenModelSawNotice: Record<string, boolean> = {};
  provider = await startLoopbackProvider({
    turns: [
      {
        call: {
          tool: 'shell',
          args: { command: options.command, description: 'Run the background job', background: true },
        },
      },
      { text: 'LAUNCHED' },
      { text: 'NOTED' },
    ],
    onRequest: (n) => {
      if (n !== 3) return;
      for (const name of options.names) {
        const file = path.join(w.workspace, `${name}.pid`);
        if (!fs.existsSync(file)) continue;
        pids[name] = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        leaked.add(pids[name]!);
      }
      aliveWhenModelSawNotice = Object.fromEntries(Object.entries(pids).map(([k, pid]) => [k, processAlive(pid)]));
    },
  });
  writeWorldSettings(w, provider.baseUrl, {
    sandbox: { enabled: false },
    shell: { autoApproveMode: 'always', ...options.settings },
  });
  session = spawnTerminal('node', [builtCli], {
    cwd: w.workspace,
    env: { ...w.env, [HARNESS_IDLE_ENV]: idlePath },
    cols: 100,
    rows: 30,
  });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  session.write('start the job');
  await waitForHarnessComposerValue(idlePath, 'start the job');
  session.write('\r');
  // Request 3 is the model's turn on the completion notification.
  await expect.poll(() => provider!.requests().length, { timeout: 40_000 }).toBeGreaterThanOrEqual(3);
  const notice = JSON.stringify(provider.requests()[2]?.messages.at(-1)?.content);
  return { world: w, notice, pids, aliveWhenModelSawNotice, launchResult: provider.requests()[1]?.messages.at(-1) };
}

describe('shell.backgroundTimeout', () => {
  it(
    'stops a background job that outlives it, kills its process tree, and tells the model',
    { timeout: 90_000 },
    async () => {
      const names = ['parent', 'child', 'grandchild'];
      const result = await runBackgroundJob({
        command:
          'echo $$ > parent.pid; sleep 61 & echo $! > child.pid; ' +
          '(sleep 62 & echo $! > grandchild.pid; wait) & echo before-timeout; wait',
        // The foreground limit is generous here; a background job must be bound by its own setting.
        settings: { backgroundTimeout: 1500 },
        names,
      });
      expect(String(result.launchResult?.content)).toContain('"status":"running"');
      expect(result.notice).toContain('status: timed_out');
      expect(result.notice).toContain(
        'Terminated: the command reached the end of the 1500ms background-setting timeout and was stopped.',
      );
      expect(result.notice).toContain('before-timeout');
      expect(Object.keys(result.pids).sort()).toEqual([...names].sort());
      expect(result.aliveWhenModelSawNotice).toEqual({ parent: false, child: false, grandchild: false });
      for (const pid of Object.values(result.pids)) expect(processAlive(pid), `pid ${pid}`).toBe(false);
    },
  );

  it('is read from settings, and a short shell.timeout does not apply to the job', { timeout: 90_000 }, async () => {
    // The same 2.5 s job a 1.5 s background limit would kill. shell.timeout is shorter than the job and
    // must be ignored on this path.
    const result = await runBackgroundJob({
      command: 'sleep 2.5; echo finished > marker.txt; echo BACKGROUND-OUTPUT',
      settings: { backgroundTimeout: 30_000, timeout: 1000 },
      names: [],
    });
    expect(result.notice).toContain('status: completed');
    expect(result.notice).toContain('BACKGROUND-OUTPUT');
    expect(result.notice).not.toContain('Terminated');
    expect(fs.readFileSync(path.join(result.world.workspace, 'marker.txt'), 'utf8')).toBe('finished\n');
  });
});
