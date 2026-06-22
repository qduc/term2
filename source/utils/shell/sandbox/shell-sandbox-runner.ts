import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';
import { createSandboxRuntimeConfig, type SandboxAvailability, type ShellSandboxRunner } from './sandbox-policy.js';

export class AnthropicShellSandboxRunner implements ShellSandboxRunner {
  #initializedForCwd: string | undefined;
  #initializationFailure: SandboxAvailability | undefined;

  async availability(): Promise<SandboxAvailability> {
    if (!SandboxManager.isSupportedPlatform()) {
      return { type: 'unsupported_platform', reason: 'Sandbox runtime does not support this platform.' };
    }

    const dependencyCheck = SandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      return { type: 'missing_dependency', reason: dependencyCheck.errors.join('; ') };
    }

    if (this.#initializationFailure) {
      return this.#initializationFailure;
    }

    return { type: 'available' };
  }

  async wrap(
    command: string,
    options: {
      cwd: string;
      signal?: AbortSignal;
    },
  ): Promise<{ command: string; diagnostics?: string[] }> {
    await this.#initialize(options.cwd);
    const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, options.signal);
    const diagnostics = SandboxManager.getLinuxGlobPatternWarnings?.() ?? [];
    return { command: wrapped, diagnostics };
  }

  annotateFailure(command: string, stderr: string): string {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
  }

  async #initialize(cwd: string): Promise<void> {
    if (this.#initializedForCwd === cwd) {
      return;
    }

    try {
      if (this.#initializedForCwd) {
        await SandboxManager.reset();
      }
      process.env.CLAUDE_CODE_TMPDIR = SANDBOX_TEMP_DIR;
      await SandboxManager.initialize(createSandboxRuntimeConfig());
      this.#initializedForCwd = cwd;
      this.#initializationFailure = undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#initializationFailure = { type: 'initialization_failed', reason };
      throw error;
    }
  }
}

let defaultRunner: AnthropicShellSandboxRunner | undefined;

export function getDefaultShellSandboxRunner(): ShellSandboxRunner {
  defaultRunner ??= new AnthropicShellSandboxRunner();
  return defaultRunner;
}
