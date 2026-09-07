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
        // Put it first so inherited flags and diagnostics remain in effect
        // rather than being silently discarded.
        execArgv: [
          '--require',
          join(
            dirname(fileURLToPath(import.meta.url)),
            import.meta.url.endsWith('.ts') ? 'worker-cwd-preload.cts' : 'worker-cwd-preload.cjs',
          ),
          ...process.execArgv,
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
