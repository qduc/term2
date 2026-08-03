import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedWorkspaceLease,
  removeIsolatedWorkspaceRoot,
  withIsolatedWorkspace,
  type IsolatedWorkspaceLease,
} from './provider-test-harness.js';

const CHILD = join(process.cwd(), 'scripts/provider-black-box/provider-harness-child.mjs');
const OWNER = join(process.cwd(), 'scripts/provider-black-box/provider-reaper-owner.ts');
const TSX = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

describe('provider black-box harness', () => {
  it('passes bounded retry settings to isolated root removal', async () => {
    let receivedOptions: RootRemovalOptionsForTest | undefined;

    await removeIsolatedWorkspaceRoot('/tmp/term2-provider-blackbox-root', async (_root, options) => {
      receivedOptions = options;
    });

    expect(receivedOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  it('reuses one isolated lease across PTY child launches and relaunches', async () => {
    await withIsolatedWorkspace({}, async (workspace) => {
      const first = await workspace.start({
        command: process.execPath,
        args: [CHILD, 'write'],
        env: { TERM2_HARNESS_MARKER_DIR: workspace.root },
      });
      await first.waitForVisibleOutput('wrote marker');
      await expect(first.waitForExit()).resolves.toMatchObject({ exitCode: 0 });

      const second = await workspace.relaunch({
        command: process.execPath,
        args: [CHILD, 'read'],
        env: { TERM2_HARNESS_MARKER_DIR: workspace.root },
      });
      await second.waitForOutput('read marker: written by first child');
      await expect(second.waitForExit()).resolves.toMatchObject({ exitCode: 0 });
      expect(second.readVisibleOutput()).toContain('read marker: written by first child');
      expect(workspace.root).toContain('term2-provider-blackbox-');
    });
  });

  it('writes through the PTY and waits for visible state before exit', async () => {
    await withIsolatedWorkspace({}, async (workspace) => {
      const child = await workspace.start({ command: process.execPath, args: [CHILD, 'echo'] });
      await child.waitForVisibleOutput('ready');
      await child.write('stateful prompt\n');
      await child.waitForState((snapshot) => snapshot.visibleOutput.includes('echo: stateful prompt'));
      await expect(child.waitForExit()).resolves.toMatchObject({ exitCode: 0 });
      expect(child.readVisible()).toContain('echo: stateful prompt');
    });
  });

  it('awaits termination after a bounded timeout', async () => {
    const workspace = await createIsolatedWorkspaceLease();
    try {
      const child = await workspace.start({ command: process.execPath, args: [CHILD, 'hang'] });
      await child.waitForOutput('hanging');
      await expect(child.waitForExit(50)).rejects.toThrow(/timed out/i);
      const exit = await child.terminate({ graceMs: 50, timeoutMs: 1_000 });
      expect(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL' || exit.exitCode !== null).toBe(true);
      await expect(child.waitForExit(250)).resolves.toEqual(exit);
    } finally {
      await workspace.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('reaps a timed-out one-shot child tree', async () => {
    const workspace = await createIsolatedWorkspaceLease();
    try {
      const distDir = join(workspace.root, 'dist');
      await mkdir(distDir, { recursive: true });
      await writeFile(join(workspace.root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      await copyFile(CHILD, join(distDir, 'cli.js'));
      const pidPath = join(workspace.root, 'tree-leaf.pid');

      const result = await workspace.runCli({
        cwd: workspace.root,
        args: ['spawn-tree-and-hang'],
        env: { TERM2_HARNESS_TREE_PID_PATH: pidPath },
        deadlineMs: 1_000,
      });

      expect(result.timedOut).toBe(true);
      expect(result.stdout).toContain('tree ready');
      const leafPid = Number((await readFile(pidPath, 'utf8')).trim());
      expect(Number.isInteger(leafPid)).toBe(true);
      await waitForProcessToExit(leafPid);
    } finally {
      await workspace.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reaps a live PTY child when the owning process is signalled without cleanup',
    async () => {
      const workspace = await createIsolatedWorkspaceLease();
      try {
        const pidPath = join(workspace.root, 'pty-child.pid');
        const owner = spawn(process.execPath, [TSX, OWNER, CHILD, pidPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        try {
          await waitForOwnerReady(owner);
          const ptyChildPid = Number((await readFile(pidPath, 'utf8')).trim());
          expect(Number.isInteger(ptyChildPid)).toBe(true);
          expect(isProcessAlive(ptyChildPid)).toBe(true);

          owner.kill('SIGTERM');

          await waitForProcessToExit(ptyChildPid, 10_000);
        } finally {
          owner.kill('SIGKILL');
        }
      } finally {
        await workspace.cleanup();
      }
    },
    20_000,
  );

  it('retries concurrent workspace cleanup after a transient owned failure', async () => {
    let removeAttempts = 0;
    const workspace = await createIsolatedWorkspaceLease({
      removeRoot: async (root) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error('transient root cleanup failure');
        await rm(root, { recursive: true, force: true });
      },
    });

    const first = workspace.cleanup();
    const second = workspace.cleanup();
    const failures = await Promise.allSettled([first, second]);
    expect(failures).toHaveLength(2);
    expect(failures.every((result) => result.status === 'rejected')).toBe(true);
    expect(removeAttempts).toBe(1);

    await expect(workspace.cleanup()).resolves.toBeUndefined();
    expect(removeAttempts).toBe(2);
    await expect(access(workspace.root)).rejects.toThrow();
  });

  it('rejects new work while cleanup is active and after a failed attempt', async () => {
    let removeAttempts = 0;
    let signalRemovalStarted: (() => void) | undefined;
    let releaseRemoval: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      signalRemovalStarted = resolve;
    });
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const workspace = await createIsolatedWorkspaceLease({
      removeRoot: async (root) => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          signalRemovalStarted?.();
          await removalGate;
          throw new Error('transient closing failure');
        }
        await rm(root, { recursive: true, force: true });
      },
    });
    let cleanup: Promise<void> | undefined;

    try {
      const child = await workspace.start({
        command: process.execPath,
        args: [CHILD, 'write'],
        env: { TERM2_HARNESS_MARKER_DIR: workspace.root },
      });
      await child.waitForExit();
      cleanup = workspace.cleanup();
      await removalStarted;

      await expect(workspace.start({ command: process.execPath, args: [CHILD, 'hang'] })).rejects.toThrow(
        /cleanup.*progress|closing|unavailable/i,
      );
      await expect(workspace.relaunch()).rejects.toThrow(/cleanup.*progress|closing|unavailable/i);
      await expect(workspace.runCli({ cwd: workspace.root, args: [] })).rejects.toThrow(
        /cleanup.*progress|closing|unavailable/i,
      );

      releaseRemoval?.();
      await expect(cleanup).rejects.toThrow('transient closing failure');
      await expect(workspace.start({ command: process.execPath, args: [CHILD, 'hang'] })).rejects.toThrow(
        /cleanup failed|retry cleanup|unavailable/i,
      );
      await expect(workspace.relaunch()).rejects.toThrow(/cleanup failed|retry cleanup|unavailable/i);
      await expect(workspace.runCli({ cwd: workspace.root, args: [] })).rejects.toThrow(
        /cleanup failed|retry cleanup|unavailable/i,
      );

      await expect(workspace.cleanup()).resolves.toBeUndefined();
      expect(removeAttempts).toBe(2);
    } finally {
      releaseRemoval?.();
      await cleanup?.catch(() => undefined);
      await workspace.cleanup().catch(() => undefined);
    }
  });

  it('reclaims the root when preparation fails', async () => {
    let root = '';
    let receivedOptions: RootRemovalOptionsForTest | undefined;
    const preparationError = new Error('fixture preparation failed');
    await expect(
      createIsolatedWorkspaceLease({
        removeRoot: async (preparedRoot, options) => {
          receivedOptions = options;
          await rm(preparedRoot, options);
        },
        prepare: (preparedRoot) => {
          root = preparedRoot;
          throw preparationError;
        },
      }),
    ).rejects.toBe(preparationError);
    expect(receivedOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    await expect(access(root)).rejects.toThrow();
  });

  it('preserves persistent acquisition cleanup errors', async () => {
    let root = '';
    const preparationError = new Error('fixture preparation failed');
    const cleanupError = new Error('persistent root cleanup failed');
    let thrown: unknown;

    try {
      await createIsolatedWorkspaceLease({
        removeRoot: async (preparedRoot, options) => {
          await rm(preparedRoot, options);
          throw cleanupError;
        },
        prepare: (preparedRoot) => {
          root = preparedRoot;
          throw preparationError;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([preparationError, cleanupError]);
    await expect(access(root)).rejects.toThrow();
  });

  it('runs callback cleanup even when the callback fails', async () => {
    let workspace: IsolatedWorkspaceLease | undefined;
    await expect(
      withIsolatedWorkspace({}, (created) => {
        workspace = created;
        throw new Error('scenario assertion failed');
      }),
    ).rejects.toThrow('scenario assertion failed');
    await expect(access(workspace!.root)).rejects.toThrow();
  });
});

type RootRemovalOptionsForTest = {
  recursive?: boolean;
  force?: boolean;
  maxRetries?: number;
  retryDelay?: number;
};

function waitForOwnerReady(owner: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => finish(new Error(`Reaper owner was not ready after ${timeoutMs}ms. ${stderr}`)),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      owner.stdout?.off('data', onStdout);
      owner.stderr?.off('data', onStderr);
      owner.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('owner ready')) finish();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null) => finish(new Error(`Reaper owner exited early with ${code}. ${stderr}`));
    owner.stdout?.on('data', onStdout);
    owner.stderr?.on('data', onStderr);
    owner.on('exit', onExit);
  });
}

async function waitForProcessToExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Process ${pid} remained alive after ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
