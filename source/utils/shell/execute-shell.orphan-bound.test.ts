import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { executeShellCommand } from './execute-shell.js';

/**
 * These run real processes on purpose. The defect being guarded against is a
 * property of inherited pipe file descriptors and process groups, which a fake
 * child process cannot reproduce.
 */
const ORPHAN_HOLDER = fileURLToPath(new URL('./test-fixtures/orphan-holder.mjs', import.meta.url));
const IGNORES_SIGTERM = fileURLToPath(new URL('./test-fixtures/ignores-sigterm.mjs', import.meta.url));
const LARGE_OUTPUT = fileURLToPath(new URL('./test-fixtures/large-output.mjs', import.meta.url));

const spawnedHolders: number[] = [];

afterEach(() => {
  for (const pid of spawnedHolders.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe.skipIf(process.platform === 'win32')('executeShellCommand process bounds', () => {
  it('completes when the command exits but a descendant still holds its stdout', async () => {
    const startedAt = Date.now();

    const result = await executeShellCommand(`node ${ORPHAN_HOLDER}`, {
      timeout: 30_000,
      drainGraceMs: 200,
    });

    const elapsed = Date.now() - startedAt;
    const holderPid = Number(/holder:(\d+)/.exec(result.stdout)?.[1]);
    if (Number.isInteger(holderPid)) spawnedHolders.push(holderPid);

    // The holder lives for 60s. Waiting on 'close' would block on it.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('holder:');
    // The pipe never reached EOF, so the read is explicitly incomplete.
    expect(result.outputComplete).toBe(false);
  });

  it('bounds a timeout even when the child ignores SIGTERM', async () => {
    const startedAt = Date.now();

    const result = await executeShellCommand(`node ${IGNORES_SIGTERM}`, {
      timeout: 300,
      terminationGraceMs: 300,
      drainGraceMs: 200,
    });

    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
  });

  it('latches timedOut even when the killed command then reports success', async () => {
    const result = await executeShellCommand('killed-but-exits-zero', {
      timeout: 20,
      execImpl: (_command, _options, callback) => {
        // Reports a clean exit in response to being killed, which must not be
        // allowed to erase the fact that the deadline already fired.
        return {
          kill: () => {
            queueMicrotask(() => callback(null, 'done', ''));
            return true;
          },
        } as never;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
    expect(result.timedOut).toBe(true);
  });

  it('returns complete output for an ordinary command', async () => {
    const result = await executeShellCommand(`node ${LARGE_OUTPUT}`, { timeout: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(100_000);
    expect(result.outputComplete).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
