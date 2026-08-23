import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';
import { createSandboxRuntimeConfig, type SandboxAvailability, type ShellSandboxRunner } from './sandbox-policy.js';
import { requestSandboxNetworkApproval } from './sandbox-network-approval.js';

export class AnthropicShellSandboxRunner implements ShellSandboxRunner {
  // SandboxManager is a process-wide singleton. Keep configuration and wrapping
  // together so every generated sandbox command gets the policy it requested.
  // The lock does not cover process execution: wrapped commands still run concurrently.
  static #initializedForKey: string | undefined;
  static #initializationFailure: SandboxAvailability | undefined;
  static #managerOperation: Promise<void> = Promise.resolve();
  #heldLease = false;

  async availability(): Promise<SandboxAvailability> {
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
      const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, options.signal);
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
    SandboxManager.cleanupAfterCommand();
  }

  annotateFailure(command: string, stderr: string): string {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
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
