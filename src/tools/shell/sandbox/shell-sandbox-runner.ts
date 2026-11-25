import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SandboxManager as RuntimeSandboxManager, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR, scratchDirectoryHint } from '../../../shared/utils/shell/temp-dir.js';
import { createSandboxRuntimeConfig, type SandboxAvailability, type ShellSandboxRunner } from './sandbox-policy.js';
import { requestSandboxNetworkApproval } from './sandbox-network-approval.js';
import { quoteShellArg } from '../../ssh-service.js';

/**
 * The runtime loads with the first sandbox check or command: importing it at
 * startup cost every start ~50 ms (some 45 modules, node-forge among them). Its
 * per-command state (violations, bwrap mount points) exists only after a wrap,
 * so before it loads there is nothing to clean up or annotate.
 */
let loadedManager: typeof RuntimeSandboxManager | undefined;
async function sandboxManager(): Promise<typeof RuntimeSandboxManager> {
  loadedManager ??= (await import('@anthropic-ai/sandbox-runtime')).SandboxManager;
  return loadedManager;
}

/**
 * The runtime puts its own `TMPDIR` into every wrapped command that gets the
 * network proxy, overriding the one the shell tool passes: `/tmp/claude` unless
 * `CLAUDE_CODE_TMPDIR` names another directory. Term2 never creates
 * `/tmp/claude`, so inside the sandbox `mktemp` and anything else honouring
 * `$TMPDIR` failed with ENOENT while the writable temp directory went unused.
 * Name that directory for the duration of the wrap, and make sure it exists so
 * the runtime can bind it.
 */
const RUNTIME_TMPDIR_ENV = 'CLAUDE_CODE_TMPDIR';
// Wraps under one held lease may overlap, so the variable is restored only when the last one finishes.
let runtimeTempDirHolders = 0;
let runtimeTempDirPrevious: string | undefined;
async function withRuntimeTempDir<T>(operation: () => Promise<T>): Promise<T> {
  fs.mkdirSync(SANDBOX_TEMP_DIR, { recursive: true, mode: 0o700 });
  if (runtimeTempDirHolders++ === 0) runtimeTempDirPrevious = process.env[RUNTIME_TMPDIR_ENV];
  process.env[RUNTIME_TMPDIR_ENV] = SANDBOX_TEMP_DIR;
  try {
    return await operation();
  } finally {
    if (--runtimeTempDirHolders === 0) {
      if (runtimeTempDirPrevious === undefined) delete process.env[RUNTIME_TMPDIR_ENV];
      else process.env[RUNTIME_TMPDIR_ENV] = runtimeTempDirPrevious;
    }
  }
}

/** Distinguish missing runtime prerequisites from a command denied by a working sandbox. */
export function sandboxFailure(availability?: Exclude<SandboxAvailability, { type: 'available' }>): string {
  const problem = availability
    ? `Shell sandbox unavailable (${availability.type})${'reason' in availability ? `: ${availability.reason}` : ''}.`
    : 'Shell sandbox initialization failed. Check Term2 logs for details.';
  return (
    `Error: ${problem} The command was not run. Resolve the sandbox issue before retrying the sandboxed command. ` +
    'If policy and interactive approval allow it, a one-shot run with sandbox="unsandboxed" may be requested; user approval is required.'
  );
}

export class AnthropicShellSandboxRunner implements ShellSandboxRunner {
  // The shell holds a lease through execution because SandboxManager owns a
  // process-wide policy and proxy. Wrapping-only callers take a short lock.
  static #initializedForKey: string | undefined;
  static #initializationFailure: SandboxAvailability | undefined;
  static #managerOperation: Promise<void> = Promise.resolve();
  #heldLease = false;

  async availability(): Promise<SandboxAvailability> {
    let SandboxManager: typeof RuntimeSandboxManager;
    try {
      SandboxManager = await sandboxManager();
    } catch (error) {
      // Once a startup crash, a broken installation now reports like any other missing dependency.
      return { type: 'missing_dependency', reason: error instanceof Error ? error.message : String(error) };
    }
    if (!SandboxManager.isSupportedPlatform()) {
      return { type: 'unsupported_platform', reason: 'Sandbox runtime does not support this platform.' };
    }

    const dependencyCheck = SandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      return { type: 'missing_dependency', reason: dependencyCheck.errors.join('; ') };
    }

    if (AnthropicShellSandboxRunner.#initializationFailure) {
      return AnthropicShellSandboxRunner.#initializationFailure;
    }

    return { type: 'available' };
  }

  async wrap(
    command: string,
    options: {
      cwd: string;
      config?: SandboxRuntimeConfig;
      signal?: AbortSignal;
    },
  ): Promise<{ command: string; diagnostics?: string[] }> {
    const operation = async () => {
      const config = options.config;
      const directHosts = config?.network.allowLocalBinding ? 'localhost,127.0.0.1,::1' : '';
      // Self-hosted and private-address services use the same approval proxy.
      let setup = `export NO_PROXY='${directHosts}' no_proxy='${directHosts}';`;
      if (process.platform === 'darwin' && config && !config.network.deniedDomains?.includes('*')) {
        // BSD nc cannot authenticate to the SOCKS proxy. Use authenticated HTTP CONNECT
        // and let the same proxy decide which destinations may receive SSH traffic.
        const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
        const script = fileURLToPath(new URL(`./ssh-proxy-command.${extension}`, import.meta.url));
        const nodeArguments = [process.execPath, script].map((value) => quoteShellArg(value.replaceAll('%', '%%')));
        const proxyCommand = `${nodeArguments.join(' ')} '%h' '%p'`;
        const sshCommand = `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand=${quoteShellArg(proxyCommand)}`;
        setup += ` export GIT_SSH_COMMAND=${quoteShellArg(sshCommand)};`;
        if (config.filesystem.allowRead) {
          config.filesystem.allowRead.push(script);
        }
      }
      await this.#initialize(options.cwd, config);
      const SandboxManager = await sandboxManager();
      const wrapped = await withRuntimeTempDir(() =>
        SandboxManager.wrapWithSandbox(`${setup} ${command}`, undefined, undefined, options.signal),
      );
      const diagnostics = SandboxManager.getLinuxGlobPatternWarnings?.() ?? [];
      return { command: wrapped, diagnostics };
    };
    return this.#heldLease ? operation() : this.#withManagerLock(operation);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const previous = AnthropicShellSandboxRunner.#managerOperation;
    let release!: () => void;
    AnthropicShellSandboxRunner.#managerOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          void previous.then(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          });
        });
        signal.throwIfAborted();
      } else {
        await previous;
      }
    } catch (error) {
      // Leave the queue intact until the preceding execution has settled.
      void previous.then(release);
      throw error;
    }
    this.#heldLease = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#heldLease = false;
      release();
    };
  }

  async cleanupAfterCommand(): Promise<void> {
    try {
      loadedManager?.cleanupAfterCommand();
      // Revoke this command's proxy credential even if a descendant survived.
      if (AnthropicShellSandboxRunner.#initializedForKey) await loadedManager?.reset();
    } finally {
      AnthropicShellSandboxRunner.#initializedForKey = undefined;
    }
  }

  annotateFailure(command: string, stderr: string): string {
    const annotated = loadedManager ? loadedManager.annotateStderrWithSandboxFailures(command, stderr) : stderr;
    // A write to plain /tmp fails on the sandbox's read-only mount; say where scratch files go instead.
    const hint = /Read-only file system/.test(stderr) ? scratchDirectoryHint(`${command}\n${stderr}`) : undefined;
    return hint ? `${annotated}\n${hint}` : annotated;
  }

  async #initialize(
    cwd: string,
    config: SandboxRuntimeConfig = createSandboxRuntimeConfig({ cwd, tmpDir: SANDBOX_TEMP_DIR }),
  ): Promise<void> {
    const initializationKey = JSON.stringify({ cwd, config });
    if (AnthropicShellSandboxRunner.#initializedForKey === initializationKey) {
      return;
    }

    try {
      const SandboxManager = await sandboxManager();
      if (AnthropicShellSandboxRunner.#initializedForKey) {
        await SandboxManager.reset();
      }
      const sandboxAskCallback = async ({ host, port }: { host: string; port?: number }): Promise<boolean> => {
        return requestSandboxNetworkApproval({ host, port }, cwd);
      };
      await SandboxManager.initialize(config, sandboxAskCallback);
      AnthropicShellSandboxRunner.#initializedForKey = initializationKey;
      AnthropicShellSandboxRunner.#initializationFailure = undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      AnthropicShellSandboxRunner.#initializationFailure = { type: 'initialization_failed', reason };
      throw error;
    }
  }

  async #withManagerLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = AnthropicShellSandboxRunner.#managerOperation;
    let release: () => void;
    AnthropicShellSandboxRunner.#managerOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release!();
    }
  }
}

let defaultRunner: AnthropicShellSandboxRunner | undefined;

export function getDefaultShellSandboxRunner(): ShellSandboxRunner {
  defaultRunner ??= new AnthropicShellSandboxRunner();
  return defaultRunner;
}

/** Largest delay Node timers honour; larger values fire after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type SandboxLeaseWait =
  | {
      readonly kind: 'acquired';
      readonly release: () => void;
      /** What is left of the budget for the process deadline; undefined when unbounded. */
      readonly remainingMs: number | undefined;
      readonly waitedMs: number;
    }
  | { readonly kind: 'busy'; readonly waitedMs: number };

/**
 * Take a sandbox runner's process-wide lease within a command's own time budget.
 *
 * The lease is held until the holder's command settles, so a waiter can sit
 * behind a long-running holder. Waiting spends `timeoutMs`, and `remainingMs`
 * is what the waiter's process deadline gets. `busy` means the budget ran out
 * before the lease arrived (or as it arrived), and nothing is held. An abort of
 * `signal` rejects, as `acquire` does. With no timeout the wait is unbounded.
 */
export async function acquireSandboxLeaseWithinBudget(
  acquire: (signal?: AbortSignal) => Promise<() => void>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SandboxLeaseWait> {
  const startedAt = Date.now();
  // Clamp so a huge timeout waits (effectively) forever instead of failing at once.
  const budgetSignal = timeoutMs ? AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMER_DELAY_MS)) : undefined;
  const waitSignal = budgetSignal && signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal ?? signal;
  let release: (() => void) | undefined;
  try {
    release = await acquire(waitSignal);
  } catch (error) {
    if (!budgetSignal?.aborted || signal?.aborted) throw error;
  }
  const waitedMs = Date.now() - startedAt;
  const remainingMs = timeoutMs ? timeoutMs - waitedMs : undefined;
  if (!release || (remainingMs !== undefined && remainingMs <= 0)) {
    release?.();
    return { kind: 'busy', waitedMs };
  }
  return { kind: 'acquired', release, remainingMs, waitedMs };
}
