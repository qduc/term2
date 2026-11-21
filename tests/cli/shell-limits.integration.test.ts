import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  processAlive,
  removeWorld,
  runCli,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type LoopbackProvider,
  type ScriptedTurn,
  type World,
} from '../helpers/loopback-chat-world.js';

// The built CLI against a loopback provider that plays the model, for the limits a run puts on itself:
//   shell.timeout            a foreground shell command is stopped when its deadline passes
//   agent.maxStreamOutputChars   one model response may not stream more text than this
// (shell.backgroundTimeout needs the interactive UI and is checked in shell-background-timeout.e2e.test.ts.)
//
// The commands only sleep, print, and write marker files inside the test's own workspace. The sandbox is
// off (no bubblewrap in some environments) and approvals are bypassed with shell.autoApproveMode=always so
// a shell call runs headlessly; neither affects the limits under test.

const TIMEOUT_NOTE = (ms: number, source: string) =>
  `Terminated: the command reached the end of ${source === 'invocation' ? 'its explicit' : 'the'} ${ms}ms ${
    source === 'foreground_setting' ? 'foreground-setting ' : ''
  }timeout and was stopped.`;

let world: World | undefined;
let provider: LoopbackProvider | undefined;
const leaked = new Set<number>();

afterEach(async () => {
  // A failed assertion must not leave the fixture's sleepers running.
  for (const pid of leaked) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  leaked.clear();
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

function shellTurn(command: string, extra: Record<string, unknown> = {}): ScriptedTurn {
  return { call: { tool: 'shell', args: { command, description: 'Run the fixture command', ...extra } } };
}

/** Pids a command wrote into the workspace, one file each. Missing files are skipped. */
function recordedPids(workspace: string, names: string[]): Record<string, number> {
  const pids: Record<string, number> = {};
  for (const name of names) {
    const file = path.join(workspace, `${name}.pid`);
    if (!fs.existsSync(file)) continue;
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (Number.isInteger(pid)) {
      pids[name] = pid;
      leaked.add(pid);
    }
  }
  return pids;
}

async function run(options: {
  turns: ScriptedTurn[];
  settings: Record<string, unknown>;
  onRequest?: (n: number) => void;
}) {
  world = createWorld('term2-limits');
  provider = await startLoopbackProvider({ turns: options.turns, onRequest: options.onRequest });
  writeWorldSettings(world, provider.baseUrl, {
    sandbox: { enabled: false },
    ...options.settings,
  });
  const result = await runCli(world, integrationCliPath(), ['--profile', 'bare', 'Run the fixture command']);
  return { ...result, world, requests: provider.requests() };
}

describe('shell.timeout', () => {
  it(
    'stops a command that outlives it, kills its whole process tree, and tells the model',
    { timeout: 30_000 },
    async () => {
      const names = ['parent', 'child', 'grandchild'];
      // A shell, a background child and a grandchild in a subshell, all sleeping far past the limit.
      const command =
        'echo $$ > parent.pid; sleep 61 & echo $! > child.pid; ' +
        '(sleep 62 & echo $! > grandchild.pid; wait) & echo before-timeout; wait';
      let aliveWhenModelSawResult: Record<string, boolean> | undefined;
      let pids: Record<string, number> = {};
      const result = await run({
        turns: [shellTurn(command)],
        settings: { shell: { autoApproveMode: 'always', timeout: 1500 } },
        onRequest: (n) => {
          if (n !== 2) return;
          pids = recordedPids(world!.workspace, names);
          aliveWhenModelSawResult = Object.fromEntries(Object.entries(pids).map(([k, pid]) => [k, processAlive(pid)]));
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.requests).toHaveLength(2);
      const [shellResult] = toolResults(result.requests[1]);
      expect(shellResult?.text).toContain(TIMEOUT_NOTE(1500, 'foreground_setting'));
      expect(shellResult?.text).toContain('increasing the timeout does not authorize replaying the command');
      // Output produced before the deadline is kept.
      expect(shellResult?.text).toContain('before-timeout');
      // The command ran and was stopped, not refused: all three processes existed, and none was left.
      expect(Object.keys(pids).sort()).toEqual([...names].sort());
      expect(aliveWhenModelSawResult).toEqual({ parent: false, child: false, grandchild: false });
      for (const pid of Object.values(pids)) expect(processAlive(pid), `pid ${pid}`).toBe(false);
    },
  );

  it.each([
    { timeout: 1000, stopped: true },
    { timeout: 20_000, stopped: false },
  ])(
    'is read from settings: a $timeout ms limit stops a 2.5 s command = $stopped',
    { timeout: 30_000 },
    async ({ timeout, stopped }) => {
      const result = await run({
        turns: [shellTurn('sleep 2.5; echo finished > marker.txt; echo FINISHED-OUTPUT')],
        settings: { shell: { autoApproveMode: 'always', timeout } },
      });
      expect(result.status, result.stderr).toBe(0);
      const [shellResult] = toolResults(result.requests[1]);
      const marker = path.join(result.world.workspace, 'marker.txt');
      if (stopped) {
        expect(shellResult?.text).toContain(TIMEOUT_NOTE(timeout, 'foreground_setting'));
        expect(shellResult?.text).not.toContain('FINISHED-OUTPUT');
        expect(fs.existsSync(marker)).toBe(false);
      } else {
        // Under the limit the command is untouched: its own exit status, its output, its effect.
        expect(shellResult?.text).toContain('exit 0');
        expect(shellResult?.text).toContain('FINISHED-OUTPUT');
        expect(shellResult?.text).not.toContain('Terminated');
        expect(fs.readFileSync(marker, 'utf8')).toBe('finished\n');
      }
    },
  );

  it('yields to an explicit timeout_ms on the call, and says whose limit it was', { timeout: 30_000 }, async () => {
    const result = await run({
      turns: [shellTurn('sleep 8; echo finished > marker.txt', { timeout_ms: 1000 })],
      settings: { shell: { autoApproveMode: 'always', timeout: 60_000 } },
    });
    expect(result.status, result.stderr).toBe(0);
    const [shellResult] = toolResults(result.requests[1]);
    expect(shellResult?.text).toContain(TIMEOUT_NOTE(1000, 'invocation'));
    expect(fs.existsSync(path.join(result.world.workspace, 'marker.txt'))).toBe(false);
  });

  it('still stops a command that ignores SIGTERM', { timeout: 30_000 }, async () => {
    const names = ['parent', 'child'];
    let pids: Record<string, number> = {};
    let aliveWhenModelSawResult: Record<string, boolean> | undefined;
    const result = await run({
      turns: [shellTurn("trap '' TERM; echo $$ > parent.pid; sleep 61 & echo $! > child.pid; wait")],
      settings: { shell: { autoApproveMode: 'always', timeout: 1000 } },
      onRequest: (n) => {
        if (n !== 2) return;
        pids = recordedPids(world!.workspace, names);
        aliveWhenModelSawResult = Object.fromEntries(Object.entries(pids).map(([k, pid]) => [k, processAlive(pid)]));
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const [shellResult] = toolResults(result.requests[1]);
    expect(shellResult?.text).toContain(TIMEOUT_NOTE(1000, 'foreground_setting'));
    expect(Object.keys(pids).sort()).toEqual([...names].sort());
    expect(aliveWhenModelSawResult).toEqual({ parent: false, child: false });
  });
});

describe('agent.maxStreamOutputChars', () => {
  const TEXT_LIMIT_MESSAGE = 'Model output was stopped because text exceeded its limit.';
  const text = (length: number, char = 'A') => char.repeat(length);

  it('fails the turn when one response streams more text than the limit, without a retry', async () => {
    const result = await run({
      turns: [{ text: text(300) }],
      settings: { agent: { maxStreamOutputChars: 100 } },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(TEXT_LIMIT_MESSAGE);
    // Nothing of the oversized response is presented as the answer, and the model is not asked again.
    expect(result.stdout).not.toContain('AAAA');
    expect(result.requests).toHaveLength(1);
  });

  it('is read from settings: the same 300-character response passes whole under a larger limit', async () => {
    const result = await run({
      turns: [{ text: text(300) }],
      settings: { agent: { maxStreamOutputChars: 1000 } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(text(300));
    expect(result.stderr).not.toContain(TEXT_LIMIT_MESSAGE);
  });

  it.each([
    { length: 200, passes: true },
    { length: 201, passes: false },
  ])(
    'treats the limit as inclusive: $length characters against a limit of 200 passes = $passes',
    async ({ length, passes }) => {
      const result = await run({
        turns: [{ text: text(length) }],
        settings: { agent: { maxStreamOutputChars: 200 } },
      });
      if (passes) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(text(length));
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(TEXT_LIMIT_MESSAGE);
      }
    },
  );

  it('counts the whole response, not each streamed frame', async () => {
    const result = await run({
      turns: [{ deltas: [text(60, 'B'), text(60, 'C'), text(60, 'D')] }],
      settings: { agent: { maxStreamOutputChars: 100 } },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(TEXT_LIMIT_MESSAGE);
  });

  it('counts each model request on its own, not the whole run', async () => {
    const result = await run({
      turns: [
        { text: text(60, 'B'), call: { tool: 'shell', args: { command: 'echo hi', description: 'Say hi' } } },
        { text: text(60, 'C') },
      ],
      settings: {
        sandbox: { enabled: false },
        shell: { autoApproveMode: 'always' },
        agent: { maxStreamOutputChars: 100 },
      },
    });
    // 120 characters were streamed across the run; no single response passed 100.
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.stdout).toContain(text(60, 'C'));
  });

  it('does not fail the turn when reasoning, not text, passes the limit', async () => {
    const result = await run({
      turns: [{ reasoning: text(300, 'R'), text: 'short answer' }],
      settings: { agent: { maxStreamOutputChars: 100 } },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('short answer');
  });
});
