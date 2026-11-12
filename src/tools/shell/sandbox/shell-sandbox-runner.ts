import fs from 'node:fs';
import type { SandboxManager as RuntimeSandboxManager, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../../../shared/utils/shell/temp-dir.js';
import { createSandboxRuntimeConfig, type SandboxAvailability, type ShellSandboxRunner } from './sandbox-policy.js';
import { requestSandboxNetworkApproval } from './sandbox-network-approval.js';

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
async function withRuntimeTempDir<T>(operation: () => Promise<T>): Promise<T> {
  fs.mkdirSync(SANDBOX_TEMP_DIR, { recursive: true, mode: 0o700 });
  const previous = process.env[RUNTIME_TMPDIR_ENV];
  process.env[RUNTIME_TMPDIR_ENV] = SANDBOX_TEMP_DIR;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_TMPDIR_ENV];
    else process.env[RUNTIME_TMPDIR_ENV] = previous;
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
  // SandboxManager is a process-wide singleton. Keep configuration and wrapping
  // together so every generated sandbox command gets the policy it requested.
  // The lock does not cover process execution: wrapped commands still run concurrently.
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
      await this.#initialize(options.cwd, options.config);
      const SandboxManager = await sandboxManager();
      const wrapped = await withRuntimeTempDir(() =>
        SandboxManager.wrapWithSandbox(command, undefined, undefined, options.signal),
      );
      const diagnostics = SandboxManager.getLinuxGlobPatternWarnings?.() ?? [];
      return { command: wrapped, diagnostics };
    };
    return this.#heldLease ? operation() : this.#withManagerLock(operation);
  }

  async acquire(): Promise<() => void> {
    const previous = AnthropicShellSandboxRunner.#managerOperation;
    let release!: () => void;
    AnthropicShellSandboxRunner.#managerOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.#heldLease = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#heldLease = false;
      release();
    };
  }

  cleanupAfterCommand(): void {
    loadedManager?.cleanupAfterCommand();
  }

  annotateFailure(command: string, stderr: string): string {
    return loadedManager ? loadedManager.annotateStderrWithSandboxFailures(command, stderr) : stderr;
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
        return requestSandboxNetworkApproval({ host, port });
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
