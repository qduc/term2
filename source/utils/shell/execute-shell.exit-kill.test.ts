import { afterEach, describe, expect, it } from 'vitest';
import { executeShellCommand, killLiveShellChildren } from './execute-shell.js';

/**
 * Real processes on purpose: the defect is that detached children survive the
 * CLI's exit, which is a property of process groups no fake can reproduce.
 * The command prints its own pid, which is the group leader, then sleeps well
 * past the test so only the kill can end it.
 */
const LONG_SLEEP = 'echo pid:$$; sleep 60';

const strays: number[] = [];

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe.skipIf(process.platform === 'win32')('killLiveShellChildren', () => {
  it('kills the process group of a command still in flight', async () => {
    const pending = executeShellCommand(LONG_SLEEP, { timeout: 30_000, drainGraceMs: 200 });

    // Let the shell print its pid before we pull the plug.
    await new Promise((resolve) => setTimeout(resolve, 500));
    killLiveShellChildren();

    const result = await pending;
    const pid = Number(/pid:(\d+)/.exec(result.stdout)?.[1]);
    if (Number.isInteger(pid)) strays.push(pid);

    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(pid)).toBe(false);
  });

  it('does not touch a command that already finished', async () => {
    await executeShellCommand('echo done', { timeout: 10_000 });

    // No live children remain to kill, so this is a no-op rather than a throw.
    expect(() => killLiveShellChildren()).not.toThrow();
  });
});
