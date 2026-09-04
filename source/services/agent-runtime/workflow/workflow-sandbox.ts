import type { Worker } from 'node:worker_threads';
import { createSandbox } from '../../sandboxed-code-host/sandbox.js';

/**
 * Creates a fresh, disposable workflow worker: the shared sandbox bound to the
 * single `agent` capability. Kept as a named factory because callers and tests
 * build a workflow worker without knowing the host's capability vocabulary.
 */
export function createWorkflowSandbox(code: string, syncTimeoutMs: number, maxConsoleBytes?: number): Worker {
  return createSandbox(code, {
    syncTimeoutMs,
    maxConsoleBytes,
    subject: 'Workflow',
    capabilities: [{ name: 'agent', kind: 'factory' }],
  });
}
