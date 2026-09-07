import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkerSource } from './host-worker.js';
import type { CapabilityBinding } from './host-types.js';

export interface SandboxOptions {
  syncTimeoutMs: number;
  maxConsoleBytes?: number;
  subject?: string;
  /** When set, a script that returns nothing completes with `null` instead of failing. */
  allowVoidOutput?: boolean;
  capabilities: readonly CapabilityBinding[];
}

function workerExecArgv(): string[] {
  const inherited = process.execArgv;
  const args: string[] = [];
  for (let index = 0; index < inherited.length; index++) {
    const argument = inherited[index];
    if (argument === '-e' || argument === '--eval' || argument === '-p' || argument === '--print') {
      index++;
      continue;
    }
    if (argument === '--input-type' || argument.startsWith('--input-type=')) {
      if (argument === '--input-type') index++;
      continue;
    }
    if (argument === '--import' && /(?:^|[/\\])tsx[/\\]esm(?:[/\\]|$)/.test(inherited[index + 1] ?? '')) {
      index++;
      continue;
    }
    if (argument.startsWith('--import=') && /(?:^|[/\\])tsx[/\\]esm(?:[/\\]|$)/.test(argument.slice(9))) continue;
    args.push(argument);
  }
  return args;
}

/**
 * Creates a fresh, disposable worker. The worker's application-facing context is
 * built inside the worker template and contains no host objects.
 */
export function createSandbox(code: string, options: SandboxOptions): Worker {
  let cwdNeedsRepair = false;
  try {
    process.cwd();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cwdNeedsRepair = true;
  }
  const workerOptions = cwdNeedsRepair
    ? {
        // Node loads this absolute local preload before evaluating the worker.
        // Put it first so inherited permission flags and diagnostics remain in
        // effect rather than being silently discarded. Eval/input-type flags
        // describe the parent entrypoint, not this eval worker; tsx's loader
        // also calls pathToFileURL(process.cwd()) during eval. Both fail after
        // cwd deletion, even when this preload is ordered first.
        execArgv: [
          '--require',
          join(
            dirname(fileURLToPath(import.meta.url)),
            import.meta.url.endsWith('.ts') ? 'worker-cwd-preload.cts' : 'worker-cwd-preload.cjs',
          ),
          ...workerExecArgv(),
        ],
      }
    : {};
  return new Worker(buildWorkerSource(options.capabilities), {
    eval: true,
    ...workerOptions,
    workerData: {
      code,
      syncTimeoutMs: options.syncTimeoutMs,
      maxConsoleBytes: options.maxConsoleBytes,
      subject: options.subject,
      allowVoidOutput: options.allowVoidOutput,
    },
  });
}
