import { Worker } from 'node:worker_threads';
import { workerBootstrapExecArgv } from '../../../utils/worker-bootstrap.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
function resolveWorkerFile() {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const tsPath = path.join(currentDir, 'session-index-worker.ts');
    const jsPath = path.join(currentDir, 'session-index-worker.js');
    if (fs.existsSync(tsPath))
        return tsPath;
    return jsPath;
}
function createDefaultWorker(workerFile) {
    const bootstrap = `
import('node:module').then(({ createRequire }) => {
  const req = createRequire(import.meta.url);
  const { workerData } = req('node:worker_threads');
  // Resolve the loader from the installed app, not the user's project cwd.
  const { createJiti } = createRequire(workerData.workerFile)('jiti');
  const jiti = createJiti(workerData.workerFile);
  const mod = jiti(workerData.workerFile);
  mod.runSessionIndexWorker();
});
`;
    return new Worker(bootstrap, {
        eval: true,
        execArgv: workerBootstrapExecArgv(),
        workerData: { workerFile },
    });
}
const DEFAULT_WORKER_TIMEOUT_MS = 10_000;
export function resolveWorkerTimeoutMs(optionsTimeout) {
    if (typeof optionsTimeout === 'number' && Number.isFinite(optionsTimeout) && optionsTimeout > 0) {
        return optionsTimeout;
    }
    const envVal = process.env['TERM2_SESSION_INDEX_TIMEOUT_MS'];
    if (envVal !== undefined && envVal.trim() !== '') {
        const parsed = Number(envVal);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_WORKER_TIMEOUT_MS;
}
export class SessionIndexWorkerClient {
    #worker;
    #timeoutMs;
    #nextRequestId = 1;
    #closed = false;
    #unavailable = false;
    #pending = new Map();
    /**
     * `dbPath`/`sourceDirectory` are optional so the same worker client can host
     * requests that never touch the SQLite index (see `listConversationsInDirectory`).
     * The index is initialized only when both are supplied.
     */
    constructor(dbPath, sourceDirectory, options) {
        this.#timeoutMs = resolveWorkerTimeoutMs(options?.timeoutMs);
        const workerFile = resolveWorkerFile();
        this.#worker = options?.workerFactory?.(workerFile) ?? createDefaultWorker(workerFile);
        this.#worker.on('message', (msg) => {
            if (!msg || typeof msg !== 'object')
                return;
            const pending = this.#pending.get(msg.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.#pending.delete(msg.id);
            if (!msg.ok) {
                pending.reject(new Error(msg.error));
            }
            else {
                pending.resolve(msg.result);
            }
        });
        this.#worker.on('error', (err) => {
            this.#unavailable = true;
            this.#drainPending(err);
        });
        this.#worker.on('exit', (code) => {
            if (!this.#closed) {
                this.#unavailable = true;
                this.#drainPending(new Error(`Session index worker stopped with exit code ${code}`));
            }
        });
        // Send init request synchronously on creation; catch errors so failures surface gracefully on probe/reconcile
        if (dbPath !== undefined && sourceDirectory !== undefined) {
            void this.#send({ type: 'init', dbPath, sourceDirectory }).catch(() => {
                // Ignored: initialization failure is captured and reported on subsequent requests
            });
        }
    }
    #drainPending(error) {
        for (const [, p] of this.#pending) {
            clearTimeout(p.timer);
            p.reject(error);
        }
        this.#pending.clear();
    }
    #send(req) {
        if (this.#closed) {
            return Promise.reject(new Error('SessionIndexWorkerClient is closed'));
        }
        if (this.#unavailable)
            return Promise.reject(new Error('Session index worker is unavailable'));
        const id = this.#nextRequestId++;
        const payload = { id, ...req };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Session index worker request timed out after ${this.#timeoutMs}ms`));
            }, this.#timeoutMs);
            this.#pending.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            this.#worker.postMessage(payload);
        });
    }
    async probe() {
        return this.#send({ type: 'probe' });
    }
    async browseCanonical(conversationsDir, context, request) {
        return this.#send({ type: 'canonical_browse', conversationsDir, context, ...request });
    }
    async reconcile() {
        return this.#send({ type: 'reconcile' });
    }
    async list(options) {
        return this.#send({ type: 'list', options });
    }
    /**
     * Canonical resume-listing parse in the worker thread. Independent of the
     * index database, so it succeeds even when the index is unavailable.
     */
    async listConversationsInDirectory(conversationsDir, projectPath, sshHost, limit) {
        return this.#send({
            type: 'list_conversations',
            conversationsDir,
            projectPath,
            sshHost,
            limit,
        });
    }
    async resolveReference(reference, options) {
        return this.#send({ type: 'resolve', reference, options });
    }
    async getRevision(sessionId) {
        return this.#send({ type: 'get_revision', sessionId });
    }
    async readSession(sessionId, options) {
        return this.#send({ type: 'read_session', sessionId, options });
    }
    async search(options) {
        return this.#send({ type: 'search', options });
    }
    async close(options) {
        if (this.#closed)
            return;
        try {
            if (!options?.force && !this.#unavailable)
                await this.#send({ type: 'close' });
        }
        catch {
            // Ignore errors on close
        }
        finally {
            this.#closed = true;
            this.#drainPending(new Error('SessionIndexWorkerClient is closed'));
            await this.#worker.terminate();
        }
    }
}
//# sourceMappingURL=session-index-worker-client.js.map