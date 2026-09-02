import { createWriteStream, existsSync, rmSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { resolveSettingsDirectory } from '../../source/services/settings/settings-path.js';
import {
  HARNESS_IDLE_ENV,
  readHarnessComposerState,
  readHarnessIdleGeneration,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../source/lib/harness-input-idle.js';

const openWorkspaceRoots = new Set<string>();

process.on('exit', () => {
  for (const root of openWorkspaceRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Process is terminating; ignore errors
    }
  }
});

// Shared-runner reality: a PTY scenario's turn can legitimately take longer
// than a developer laptop under vitest's parallel workers. --bail=1 bounds a
// genuine hang to one scenario, so a generous ceiling costs little and stops
// per-call-site timeout whack-a-mole. Scenario files import this constant for
// their own fixture waits so the suite has one shared ceiling, not per-file
// duplicates that flake independently.
export const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;
const DEFAULT_TERMINATE_TIMEOUT_MS = 2_000;
const ROOT_REMOVAL_MAX_RETRIES = 5;
const ROOT_REMOVAL_RETRY_DELAY_MS = 50;
const PYTHON_PTY_BRIDGE = ['import pty', 'import sys', 'sys.exit(pty.spawn(sys.argv[1:]))'].join('; ');

const ROOT_REMOVAL_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: ROOT_REMOVAL_MAX_RETRIES,
  retryDelay: ROOT_REMOVAL_RETRY_DELAY_MS,
} as const;

type RootRemoval = (root: string, options: typeof ROOT_REMOVAL_OPTIONS) => Promise<void>;

const removeRootWithFsRm: RootRemoval = (root, options) => rm(root, options);

/**
 * PTY children are spawned detached so the harness can signal their whole
 * process group. That also means they outlive an interrupted run: a Ctrl-C or
 * a killed vitest worker skips `afterEach`, and the child is reparented to init
 * and idles forever holding a PTY. Orphans accumulated across runs this way.
 *
 * Every live child is tracked here and reaped on process teardown, which is the
 * one path an interrupted run still takes.
 */
const liveTerminals = new Set<ChildProcess>();
const REAPED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Synchronous by necessity — `exit` listeners cannot await. */
function reapLiveTerminals(): void {
  for (const terminal of liveTerminals) signalChild(terminal, 'SIGKILL', true);
  liveTerminals.clear();
}

function onReapedSignal(signal: (typeof REAPED_SIGNALS)[number]): void {
  reapLiveTerminals();
  // Re-raise so vitest's own teardown, or the default action, still runs.
  process.off(signal, onReapedSignal);
  process.kill(process.pid, signal);
}

let reaperInstalled = false;

function installTerminalReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on('exit', reapLiveTerminals);
  for (const signal of REAPED_SIGNALS) process.on(signal, onReapedSignal);
}

export interface BlackBoxRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface IsolatedWorkspacePaths {
  configDir: string;
  stateDir: string;
  dataDir: string;
  cacheDir: string;
  codexHome: string;
  conversationsDir: string;
  logDir: string;
  outputsDir: string;
  idlePath: string;
}

export interface ChildExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ChildSnapshot {
  output: string;
  visibleOutput: string;
  exit: ChildExit | null;
}

export interface PtyChildDriver {
  readonly pid: number | undefined;
  read(): string;
  readVisible(): string;
  readOutput(): string;
  readVisibleOutput(): string;
  getOutput(): string;
  getVisibleOutput(): string;
  write(data: string, timeoutMs?: number): Promise<void>;
  waitForOutput(needle: string, timeoutMs?: number): Promise<void>;
  waitForVisibleOutput(needle: string, timeoutMs?: number): Promise<void>;
  waitForState(predicate: (snapshot: ChildSnapshot) => boolean, timeoutMs?: number): Promise<ChildSnapshot>;
  /** Latest composer-idle generation, or 0 before the child has accepted input. */
  readIdleGeneration(): number;
  /** Latest application-owned composer revision, or 0 before publication. */
  readComposerRevision(): number;
  /** Wait until the child publishes an idle generation greater than `after`. */
  waitForIdleInput(options?: { after?: number; timeoutMs?: number }): Promise<number>;
  /** Wait until the application-owned composer has consumed an exact value. */
  waitForComposerValue(value: string, options?: { afterRevision?: number; timeoutMs?: number }): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<ChildExit>;
  terminate(options?: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number }): Promise<ChildExit>;
  kill(signal?: NodeJS.Signals): void;
  cleanup(options?: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number }): Promise<void>;
  dispose(options?: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number }): Promise<void>;
}

export interface ChildLaunchOptions {
  /** Defaults to the current Node executable and the built CLI in `cwd`. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

export interface WorkspaceCliOptions {
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  deadlineMs?: number;
  /** Absolute path to a built CLI when the test workspace is not the package root. */
  cliPath?: string;
}

export interface IsolatedWorkspaceLease {
  readonly root: string;
  readonly paths: IsolatedWorkspacePaths;
  readonly env: NodeJS.ProcessEnv;
  start(options?: ChildLaunchOptions): Promise<PtyChildDriver>;
  relaunch(options?: ChildLaunchOptions): Promise<PtyChildDriver>;
  runCli(options: WorkspaceCliOptions): Promise<BlackBoxRun>;
  cleanup(): Promise<void>;
}

export interface CreateIsolatedWorkspaceOptions {
  prefix?: string;
  env?: Record<string, string | undefined>;
  prepare?: (root: string, paths: IsolatedWorkspacePaths) => Promise<void> | void;
  /** Narrow test seam for exercising retryable root cleanup failures. */
  removeRoot?: RootRemoval;
}

type WorkspaceLeaseState = 'open' | 'closing' | 'cleanup-failed' | 'closed';

/** Remove an isolated root with bounded retries for transient filesystem races. */
export async function removeIsolatedWorkspaceRoot(
  root: string,
  removeRoot: RootRemoval = removeRootWithFsRm,
): Promise<void> {
  await removeRoot(root, ROOT_REMOVAL_OPTIONS);
}

/**
 * Create one disposable state root that can be reused by several child
 * processes. This is intentionally a lease: the caller owns the root until
 * `cleanup()` and can relaunch a child without losing settings, history, logs,
 * cache, or Codex authentication state.
 */
export async function createIsolatedWorkspaceLease(
  options: CreateIsolatedWorkspaceOptions = {},
): Promise<IsolatedWorkspaceLease> {
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), options.prefix ?? 'term2-provider-blackbox-'));
    openWorkspaceRoots.add(root);
    const paths = createWorkspacePaths(root);
    await mkdir(paths.outputsDir, { recursive: true });
    const env = createWorkspaceEnvironment(root, paths, options.env);
    await options.prepare?.(root, paths);

    let state: WorkspaceLeaseState = 'open';
    let cleanupPromise: Promise<void> | undefined;
    let outputSequence = 0;
    let lastLaunch: ChildLaunchOptions | undefined;
    const children = new Set<PtyChildDriver>();

    const start = async (launchOptions: ChildLaunchOptions = {}): Promise<PtyChildDriver> => {
      assertLeaseOpen(state);
      const launch = resolveLaunch(launchOptions);
      const child = createPtyChild({
        ...launch,
        env: createWorkspaceEnvironment(root!, paths, { ...options.env, ...launchOptions.env }),
      });
      lastLaunch = { ...launchOptions, args: launchOptions.args ? [...launchOptions.args] : undefined };
      children.add(child);
      return child;
    };

    return {
      root,
      paths,
      env,
      start,
      relaunch: async (launchOptions: ChildLaunchOptions = {}) => {
        assertLeaseOpen(state);
        if (!lastLaunch) throw new Error('Cannot relaunch an isolated workspace before the first child starts.');
        const merged: ChildLaunchOptions = {
          ...lastLaunch,
          ...launchOptions,
          ...(launchOptions.args === undefined && lastLaunch.args ? { args: [...lastLaunch.args] } : {}),
          ...(lastLaunch.env || launchOptions.env ? { env: { ...lastLaunch.env, ...launchOptions.env } } : {}),
        };
        for (const child of children) {
          // An already-settled child is cheap to ignore. An active child is
          // terminated before relaunch so the lease never owns two live
          // interactive sessions accidentally.
          try {
            await child.waitForExit(0);
          } catch {
            await child.terminate();
          }
        }
        return start(merged);
      },
      runCli: async (cliOptions: WorkspaceCliOptions): Promise<BlackBoxRun> => {
        assertLeaseOpen(state);
        const runNumber = ++outputSequence;
        const stdoutPath = join(paths.outputsDir, `run-${runNumber}.stdout`);
        const stderrPath = join(paths.outputsDir, `run-${runNumber}.stderr`);
        return runCapturedCli({
          ...cliOptions,
          env: createWorkspaceEnvironment(root!, paths, { ...options.env, ...cliOptions.env }),
          stdoutPath,
          stderrPath,
        });
      },
      cleanup: async () => {
        if (state === 'closed') return;
        if (cleanupPromise) return cleanupPromise;
        state = 'closing';

        const attempt = (async () => {
          const failures: unknown[] = [];
          for (const child of children) {
            try {
              await child.cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            await removeIsolatedWorkspaceRoot(root!, options.removeRoot);
            openWorkspaceRoots.delete(root!);
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, 'Failed to clean up isolated workspace lease.');
        })();
        cleanupPromise = attempt;
        try {
          await attempt;
          state = 'closed';
        } catch (error) {
          state = 'cleanup-failed';
          throw error;
        } finally {
          if (cleanupPromise === attempt) cleanupPromise = undefined;
        }
      },
    };
  } catch (error) {
    // Preparation is part of lease acquisition. If it fails, the caller never
    // receives a lease, so acquisition must reclaim the root itself.
    if (root) {
      try {
        await removeIsolatedWorkspaceRoot(root, options.removeRoot);
        openWorkspaceRoots.delete(root);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to prepare and clean up isolated workspace lease.');
      }
    }
    throw error;
  }
}

function assertLeaseOpen(state: WorkspaceLeaseState): void {
  if (state === 'open') return;
  if (state === 'closing')
    throw new Error('Isolated workspace lease is closing; new work is unavailable during cleanup.');
  if (state === 'cleanup-failed')
    throw new Error('Isolated workspace lease cleanup failed; retry cleanup before starting new work.');
  throw new Error('Isolated workspace lease has already been cleaned up.');
}

/** Run a callback with a lease that is always cleaned up, including prepare failures. */
export async function withIsolatedWorkspace<T>(
  options: CreateIsolatedWorkspaceOptions,
  callback: (workspace: IsolatedWorkspaceLease) => Promise<T> | T,
): Promise<T> {
  const workspace = await createIsolatedWorkspaceLease(options);
  try {
    return await callback(workspace);
  } finally {
    await workspace.cleanup();
  }
}

/**
 * Preserve the original one-shot helper for provider-cli.blackbox.ts while
 * making its root, process, and output streams exception-safe.
 */
export async function runIsolatedCli(options: {
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  prepare?: (root: string) => Promise<void> | void;
  deadlineMs?: number;
}): Promise<BlackBoxRun> {
  const workspace = await createIsolatedWorkspaceLease({ prepare: options.prepare, env: options.env });
  try {
    return await workspace.runCli({ cwd: options.cwd, args: options.args, deadlineMs: options.deadlineMs });
  } finally {
    await workspace.cleanup();
  }
}

export async function runIsolatedCliInWorkspace(
  workspace: IsolatedWorkspaceLease,
  options: WorkspaceCliOptions,
): Promise<BlackBoxRun> {
  return workspace.runCli(options);
}

function createWorkspacePaths(root: string): IsolatedWorkspacePaths {
  const stateDir = join(root, 'state');
  return {
    configDir: join(root, 'config'),
    stateDir,
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    codexHome: join(root, 'codex'),
    conversationsDir: join(root, 'conversations'),
    // Match the platform-specific path that env-paths('term2') resolves to inside
    // the child process; the shared resolver receives isolated XDG/LOCALAPPDATA roots.
    logDir: resolveSettingsDirectory({
      platform: process.platform,
      homeDir: root,
      env: { XDG_STATE_HOME: stateDir, LOCALAPPDATA: join(root, 'AppData', 'Local') },
    }),
    outputsDir: join(root, 'outputs'),
    idlePath: join(stateDir, 'input-idle'),
  };
}

function createWorkspaceEnvironment(
  root: string,
  paths: IsolatedWorkspacePaths,
  overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|PASSWORD|SECRET)/i.test(key)),
  ) as NodeJS.ProcessEnv;
  const env: NodeJS.ProcessEnv = { ...inherited };
  // The harness creates a real PTY and drives an interactive Ink application.
  // Do not let the host runner's non-interactive marker change child input
  // behavior; callers can still opt into CI semantics through an override.
  delete env.CI;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  Object.assign(env, {
    HOME: root,
    // Node resolves os.homedir() from USERPROFILE on Windows; isolate both
    // home conventions so hooks and settings never leak into the host profile.
    USERPROFILE: root,
    XDG_CONFIG_HOME: paths.configDir,
    XDG_STATE_HOME: paths.stateDir,
    XDG_DATA_HOME: paths.dataDir,
    XDG_CACHE_HOME: paths.cacheDir,
    CODEX_HOME: paths.codexHome,
    TERM2_CONVERSATIONS_DIR: paths.conversationsDir,
    TERM2_LOG_DIR: paths.logDir,
    TERM2_CACHE_DIR: paths.cacheDir,
    [HARNESS_IDLE_ENV]: paths.idlePath,
  });
  return env;
}

function resolveLaunch(options: ChildLaunchOptions): {
  command: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
} {
  const cwd = options.cwd ?? process.cwd();
  if (options.command) {
    return { command: options.command, args: [...(options.args ?? [])], cwd, cols: options.cols, rows: options.rows };
  }
  return {
    command: process.execPath,
    args: [join(cwd, 'dist/cli.js'), ...(options.args ?? [])],
    cwd,
    cols: options.cols,
    rows: options.rows,
  };
}

function createPtyChild(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}): PtyChildDriver {
  const idlePath = options.env[HARNESS_IDLE_ENV];
  if (idlePath && existsSync(idlePath)) unlinkSync(idlePath);

  const terminal = spawn('python3', ['-u', '-c', PYTHON_PTY_BRIDGE, options.command, ...options.args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      TERM: options.env.TERM ?? 'xterm-256color',
      FORCE_COLOR: options.env.FORCE_COLOR ?? '1',
      COLUMNS: options.cols ? String(options.cols) : options.env.COLUMNS,
      LINES: options.rows ? String(options.rows) : options.env.LINES,
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  installTerminalReaper();
  liveTerminals.add(terminal);

  let output = '';
  let visibleOutput = '';
  let exitState: ChildExit | null = null;
  let spawnError: Error | null = null;
  let terminationPromise: Promise<ChildExit> | undefined;
  let resolveExit: ((exit: ChildExit) => void) | undefined;
  const exitPromise = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });

  const appendOutput = (chunk: Buffer | string): void => {
    output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    visibleOutput = stripVTControlCharacters(output);
  };

  terminal.stdout?.on('data', appendOutput);
  terminal.stderr?.on('data', appendOutput);
  terminal.on('error', (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  terminal.on('close', (code, signal) => {
    liveTerminals.delete(terminal);
    exitState = { exitCode: code, signal: signal as NodeJS.Signals | null };
    resolveExit?.(exitState);
    resolveExit = undefined;
  });

  const snapshot = (): ChildSnapshot => ({
    output,
    visibleOutput,
    exit: exitState,
  });

  const waitForState = (
    predicate: (value: ChildSnapshot) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ChildSnapshot> =>
    new Promise<ChildSnapshot>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        terminal.stdout?.off('data', onStateChange);
        terminal.stderr?.off('data', onStateChange);
        terminal.off('error', onStateChange);
        terminal.off('close', onStateChange);
        if (timer) clearTimeout(timer);
      };
      const finish = (result: { value: ChildSnapshot } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const failForExit = (current: ChildSnapshot): void => {
        const visible = current.visibleOutput;
        const tail = visible.length > 2_000 ? visible.slice(-2_000) : visible;
        finish({
          error: new Error(
            `PTY child exited before the requested state appeared (code=${current.exit?.exitCode}, signal=${current.exit?.signal}).\nchild visible output (tail):\n${tail}`,
          ),
        });
      };
      const failForTimeout = (): void => {
        const current = snapshot();
        const visible = current.visibleOutput;
        const tail = visible.length > 2_000 ? visible.slice(-2_000) : visible;
        finish({
          error: new Error(
            `Timed out waiting for PTY child state after ${timeoutMs}ms.\nchild visible output (tail):\n${tail}`,
          ),
        });
      };
      const evaluate = (): void => {
        if (settled) return;
        const current = snapshot();
        try {
          if (predicate(current)) {
            finish({ value: current });
            return;
          }
        } catch (error) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
          return;
        }
        if (spawnError) {
          finish({ error: spawnError });
          return;
        }
        if (current.exit) failForExit(current);
      };
      const onStateChange = (): void => evaluate();

      terminal.stdout?.on('data', onStateChange);
      terminal.stderr?.on('data', onStateChange);
      terminal.on('error', onStateChange);
      terminal.on('close', onStateChange);
      timer = setTimeout(failForTimeout, timeoutMs);
      // Check after subscribing so output/events that arrived just before this
      // call cannot be missed, while still avoiding a polling interval.
      evaluate();
    });

  const waitForExit = async (timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChildExit> => {
    if (exitState) return exitState;
    if (spawnError) throw spawnError;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exitPromise,
        new Promise<ChildExit>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out waiting for PTY child exit after ${timeoutMs}ms.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const terminate = async ({
    signal = 'SIGTERM',
    graceMs = DEFAULT_TERMINATE_GRACE_MS,
    timeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  }: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number } = {}): Promise<ChildExit> => {
    if (terminationPromise) return terminationPromise;
    const attempt = (async () => {
      if (exitState) return exitState;
      signalChild(terminal, signal, true);
      try {
        return await waitForExit(graceMs);
      } catch {
        signalChild(terminal, 'SIGKILL', true);
        return await waitForExit(timeoutMs);
      }
    })();
    terminationPromise = attempt;
    try {
      return await attempt;
    } catch (error) {
      if (terminationPromise === attempt) terminationPromise = undefined;
      throw error;
    }
  };

  const write = async (data: string, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS): Promise<void> => {
    if (exitState) throw new Error('Cannot write to an exited PTY child.');
    const stdin = terminal.stdin;
    if (!stdin || !stdin.writable) throw new Error('PTY child stdin is not writable.');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`Timed out writing to PTY child after ${timeoutMs}ms.`)),
        timeoutMs,
      );
      const onError = (error: Error) => finish(error);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdin.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      stdin.once('error', onError);
      try {
        stdin.write(data, 'utf8', () => finish());
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const cleanup = async (options?: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number }) => {
    await terminate(options);
    terminal.stdin?.destroy();
    terminal.stdout?.destroy();
    terminal.stderr?.destroy();
  };

  return {
    pid: terminal.pid,
    read: () => output,
    readVisible: () => visibleOutput,
    readOutput: () => output,
    readVisibleOutput: () => visibleOutput,
    getOutput: () => output,
    getVisibleOutput: () => visibleOutput,
    write,
    waitForOutput: (needle, timeoutMs) =>
      waitForState((value) => value.visibleOutput.includes(needle), timeoutMs).then(() => undefined),
    waitForVisibleOutput: (needle, timeoutMs) =>
      waitForState((value) => value.visibleOutput.includes(needle), timeoutMs).then(() => undefined),
    waitForState,
    readIdleGeneration: () => {
      const idlePath = options.env[HARNESS_IDLE_ENV];
      if (!idlePath) return 0;
      return readHarnessIdleGeneration(idlePath);
    },
    readComposerRevision: () => {
      if (!idlePath) return 0;
      return readHarnessComposerState(idlePath)?.revision ?? 0;
    },
    waitForIdleInput: async ({ after = 0, timeoutMs } = {}) => {
      const idlePath = options.env[HARNESS_IDLE_ENV];
      if (!idlePath) {
        throw new Error(`${HARNESS_IDLE_ENV} is required to wait for composer idle.`);
      }
      // Inherit the harness's shared PTY ceiling instead of the idle lib's
      // tighter 15s default: readiness under shared-runner contention is the
      // recorded flake class in docs/plans/guard-ledger.md, and --bail=1
      // bounds a genuine hang to one scenario.
      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const idleWait = waitForHarnessIdleGeneration(idlePath, { after, timeoutMs: effectiveTimeoutMs }).then(
        (generation) => ({ kind: 'idle' as const, generation }),
      );
      // Race the child's exit against the idle channel so a dead child
      // diagnoses itself instead of burning the full ceiling. waitForExit's
      // timeout rejection is expected here; the idle lib's own timeout error
      // remains authoritative for the genuinely-still-running case.
      const exitWait = waitForExit(effectiveTimeoutMs).then(
        (exit) => ({ kind: 'exited' as const, exit }),
        () => ({ kind: 'running' as const }),
      );
      const outcome = await Promise.race([idleWait, exitWait]);
      if (outcome.kind === 'idle') return outcome.generation;
      if (outcome.kind === 'exited') {
        const tail = tailOfVisibleOutput(visibleOutput);
        throw new Error(
          `PTY child exited before publishing composer idle (code=${outcome.exit.exitCode}, signal=${outcome.exit.signal}).\nchild visible output (tail):\n${tail}`,
        );
      }
      throw new Error(
        `Timed out waiting for harness idle generation > ${after} at ${idlePath} after ${effectiveTimeoutMs}ms; got ${readHarnessIdleGeneration(
          idlePath,
        )}.`,
      );
    },
    waitForComposerValue: async (value, { afterRevision, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS } = {}) => {
      if (!idlePath) {
        throw new Error(`${HARNESS_IDLE_ENV} is required to wait for composer input.`);
      }
      await waitForHarnessComposerValue(idlePath, value, {
        afterRevision: afterRevision ?? readHarnessComposerState(idlePath)?.revision ?? 0,
        timeoutMs,
      });
    },
    waitForExit,
    terminate,
    kill: (signal = 'SIGTERM') => {
      signalChild(terminal, signal, true);
    },
    cleanup,
    dispose: cleanup,
  };
}

/**
 * Write ordinary terminal text and wait for the PTY to render that text back.
 * The pre-write visible-output marker prevents an older matching prompt from
 * acknowledging the new input.
 */
export async function writePtyTextAndWaitForVisibleEcho(
  child: PtyChildDriver,
  text: string,
  timeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
): Promise<void> {
  // Ink redraws the frame rather than appending a stable visible transcript,
  // so the acknowledgement marker must be taken from the raw PTY stream.
  const outputLength = child.getOutput().length;
  await child.write(text, timeoutMs);
  const expected = text.replace(/\r\n?/g, '\n');
  await child.waitForState(
    (snapshot) =>
      stripVTControlCharacters(snapshot.output.slice(outputLength)).replace(/\r\n?/g, '\n').includes(expected),
    timeoutMs,
  );
}

/** Write ordinary terminal text, wait for application consumption, then submit it. */
export async function writePtyTextAndSubmit(
  child: PtyChildDriver,
  text: string,
  timeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
): Promise<void> {
  const afterRevision = child.readComposerRevision();
  await child.write(text, timeoutMs);
  await child.waitForComposerValue(text, { afterRevision, timeoutMs });
  await child.write('\r', timeoutMs);
}

async function runCapturedCli(options: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
  cliPath?: string;
  stdoutPath: string;
  stderrPath: string;
}): Promise<BlackBoxRun> {
  const stdout = createWriteStream(options.stdoutPath);
  const stderr = createWriteStream(options.stderrPath);
  let child: ChildProcess | undefined;
  let closed = false;
  let result: ChildExit = { exitCode: null, signal: null };
  let timedOut = false;
  try {
    child = spawn(process.execPath, [options.cliPath ?? join(options.cwd, 'dist/cli.js'), ...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);
    const deadlineMs = options.deadlineMs ?? DEFAULT_TIMEOUT_MS;
    try {
      result = await waitForProcessExit(child, deadlineMs);
      closed = true;
    } catch (error) {
      if (!(error instanceof ProcessTimeoutError)) throw error;
      timedOut = true;
      result = await terminateProcess(child);
      closed = true;
    }
    await finishWritable(stdout);
    await finishWritable(stderr);
    return {
      ...result,
      timedOut,
      stdout: await readFile(options.stdoutPath, 'utf8'),
      stderr: await readFile(options.stderrPath, 'utf8'),
      stdoutPath: options.stdoutPath,
      stderrPath: options.stderrPath,
    };
  } finally {
    if (child && !closed) {
      try {
        await terminateProcess(child);
      } catch {
        /* preserve the original preparation/spawn/read error */
      }
    }
    await finishWritable(stdout).catch(() => undefined);
    await finishWritable(stderr).catch(() => undefined);
  }
}

class ProcessTimeoutError extends Error {}

const processExitPromises = new WeakMap<ChildProcess, Promise<ChildExit>>();

function processExitPromise(child: ChildProcess): Promise<ChildExit> {
  const existing = processExitPromises.get(child);
  if (existing) return existing;
  if (child.exitCode !== null || child.signalCode !== null) {
    const settled = Promise.resolve({
      exitCode: child.exitCode,
      signal: child.signalCode as NodeJS.Signals | null,
    });
    processExitPromises.set(child, settled);
    return settled;
  }
  const promise = new Promise<ChildExit>((resolve) => {
    child.once('close', (code, signal) => resolve({ exitCode: code, signal: signal as NodeJS.Signals | null }));
  });
  processExitPromises.set(child, promise);
  return promise;
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  const exit = processExitPromise(child);
  return new Promise<ChildExit>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProcessTimeoutError()), timeoutMs);
    void exit.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function terminateProcess(child: ChildProcess): Promise<ChildExit> {
  if (!child.pid) return { exitCode: null, signal: 'SIGTERM' };
  signalChild(child, 'SIGTERM', true);
  try {
    return await waitForProcessExit(child, DEFAULT_TERMINATE_GRACE_MS);
  } catch {
    signalChild(child, 'SIGKILL', true);
    return await waitForProcessExit(child, DEFAULT_TERMINATE_TIMEOUT_MS);
  }
}

/** Bounded tail of a child's visible output for self-diagnosing wait failures. */
function tailOfVisibleOutput(visible: string, max = 2_000): string {
  return visible.length > max ? visible.slice(-max) : visible;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (!child.pid) return;
  if (processGroup && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall back to the wrapper process */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* process may already have exited */
  }
}

async function finishWritable(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableFinished) return;
  stream.end();
  try {
    await finished(stream, { cleanup: true });
  } catch {
    /* read/cleanup errors are reported by the owning operation */
  }
}

export function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const result: T[] = [];
    for await (const item of stream) result.push(item);
    return result;
  })();
}
