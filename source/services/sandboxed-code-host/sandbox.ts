import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildWorkerSource } from './host-worker.js';
import type { CapabilityBinding } from './host-types.js';

export interface SandboxOptions {
  syncTimeoutMs: number;
  maxConsoleBytes?: number;
  subject?: string;
  /** When set, a script that returns nothing completes with `null` instead of failing. */
  allowVoidOutput?: boolean;
  /** Valid execution root used while bootstrapping a worker. */
  cwd?: string;
  capabilities: readonly CapabilityBinding[];
}

/**
 * Creates a fresh, disposable worker. The worker's application-facing context is
 * built inside the worker template and contains no host objects.
 */
export function createSandbox(code: string, options: SandboxOptions): Worker {
  const workerOptions = options.cwd
    ? {
        // The generated source is plain JavaScript. A tiny CJS preload sets
        // the worker's process cwd before Node's bootstrap reads it; unlike a
        // loader, it does not need to resolve anything relative to cwd.
        execArgv: [
          '--require',
          fileURLToPath(
            new URL(
              import.meta.url.endsWith('.ts') ? './worker-cwd-preload.cts' : './worker-cwd-preload.cjs',
              import.meta.url,
            ),
          ),
        ],
        env: { ...process.env, TERM2_SANDBOX_CWD: options.cwd },
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
