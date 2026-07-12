import { Worker } from 'node:worker_threads';
import { WORKFLOW_WORKER_SOURCE } from './workflow-worker.js';

/**
 * Creates a fresh, disposable workflow worker. The worker's application-facing
 * context is built inside workflow-worker and contains no host objects.
 */
export function createWorkflowSandbox(code: string, syncTimeoutMs: number): Worker {
  return new Worker(WORKFLOW_WORKER_SOURCE, {
    eval: true,
    workerData: { code, syncTimeoutMs },
  });
}
