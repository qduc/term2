import { Worker } from 'node:worker_threads';
import { workerBootstrapExecArgv } from '../../utils/worker-bootstrap.js';
import { buildWorkerSource } from './host-worker.js';
export function serializeSandboxInputData(inputData) {
    const json = JSON.stringify(inputData);
    return { json, bytes: Buffer.byteLength(json, 'utf8') };
}
/**
 * Creates a fresh, disposable worker. The worker's application-facing context is
 * built inside the worker template and contains no host objects.
 */
export function createSandbox(code, options) {
    return new Worker(buildWorkerSource(options.capabilities), {
        eval: true,
        execArgv: workerBootstrapExecArgv(),
        workerData: {
            code,
            syncTimeoutMs: options.syncTimeoutMs,
            maxConsoleBytes: options.maxConsoleBytes,
            subject: options.subject,
            allowVoidOutput: options.allowVoidOutput,
            inputDataJson: options.inputDataJson,
        },
    });
}
//# sourceMappingURL=sandbox.js.map