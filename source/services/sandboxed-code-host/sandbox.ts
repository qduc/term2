import { Worker } from 'node:worker_threads';
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
  return new Worker(buildWorkerSource(options.capabilities), {
    eval: true,
    workerData: {
      code,
      syncTimeoutMs: options.syncTimeoutMs,
      maxConsoleBytes: options.maxConsoleBytes,
      subject: options.subject,
      allowVoidOutput: options.allowVoidOutput,
    },
  });
}
