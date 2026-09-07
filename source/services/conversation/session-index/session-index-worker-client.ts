import { Worker } from 'node:worker_threads';
import { workerBootstrapExecArgv } from '../../../utils/worker-bootstrap.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProbeCapabilityResult } from './session-index-schema.js';
import type {
  IndexedListResult,
  IndexedReadSessionResult,
  IndexedResolveResult,
  IndexedSearchResult,
  ReconcileResult,
} from './session-index-database.js';
import type { WorkerRequest, WorkerRequestPayload, WorkerResponse } from './session-index-worker.js';

export interface SessionIndexWorkerClientOptions {
  workerFactory?: (workerFile: string) => Worker;
  timeoutMs?: number;
}

function resolveWorkerFile(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const tsPath = path.join(currentDir, 'session-index-worker.ts');
  const jsPath = path.join(currentDir, 'session-index-worker.js');
  if (fs.existsSync(tsPath)) return tsPath;
  return jsPath;
}

function createDefaultWorker(workerFile: string): Worker {
  const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
const { createJiti } = require('jiti');
const jiti = createJiti(workerData.workerFile);
const mod = jiti(workerData.workerFile);
mod.runSessionIndexWorker();
`;
  return new Worker(bootstrap, {
    eval: true,
    execArgv: workerBootstrapExecArgv(),
    workerData: { workerFile },
  });
}

export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;

export function resolveWorkerTimeoutMs(optionsTimeout?: number): number {
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
  readonly #worker: Worker;
  readonly #timeoutMs: number;
  #nextRequestId = 1;
  #closed = false;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(dbPath: string, sourceDirectory: string, options?: SessionIndexWorkerClientOptions) {
    this.#timeoutMs = resolveWorkerTimeoutMs(options?.timeoutMs);
    const workerFile = resolveWorkerFile();
    this.#worker = options?.workerFactory?.(workerFile) ?? createDefaultWorker(workerFile);

    this.#worker.on('message', (msg: WorkerResponse) => {
      if (!msg || typeof msg !== 'object') return;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(msg.id);

      if (!msg.ok) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    });

    this.#worker.on('error', (err: Error) => {
      this.#drainPending(err);
    });

    this.#worker.on('exit', (code: number) => {
      if (!this.#closed) {
        this.#drainPending(new Error(`Session index worker stopped with exit code ${code}`));
      }
    });

    // Send init request synchronously on creation; catch errors so failures surface gracefully on probe/reconcile
    void this.#send({ type: 'init', dbPath, sourceDirectory }).catch(() => {
      // Ignored: initialization failure is captured and reported on subsequent requests
    });
  }

  #drainPending(error: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }

  #send<T>(req: WorkerRequestPayload): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('SessionIndexWorkerClient is closed'));
    }

    const id = this.#nextRequestId++;
    const payload: WorkerRequest = { id, ...req };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Session index worker request timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.#worker.postMessage(payload);
    });
  }

  async probe(): Promise<ProbeCapabilityResult> {
    return this.#send<ProbeCapabilityResult>({ type: 'probe' });
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.#send<ReconcileResult>({ type: 'reconcile' });
  }

  async list(options: { projectPath: string; sshHost?: string }): Promise<IndexedListResult> {
    return this.#send<IndexedListResult>({ type: 'list', options });
  }

  async resolveReference(
    reference: string,
    options: { projectPath: string; sshHost?: string; currentSessionId?: string },
  ): Promise<IndexedResolveResult> {
    return this.#send<IndexedResolveResult>({ type: 'resolve', reference, options });
  }

  async getRevision(sessionId: string): Promise<string | null> {
    return this.#send<string | null>({ type: 'get_revision', sessionId });
  }

  async readSession(
    sessionId: string,
    options: { projectPath: string; sshHost?: string },
  ): Promise<IndexedReadSessionResult> {
    return this.#send<IndexedReadSessionResult>({ type: 'read_session', sessionId, options });
  }

  async search(options: { query: string; projectPath: string; sshHost?: string }): Promise<IndexedSearchResult> {
    return this.#send<IndexedSearchResult>({ type: 'search', options });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#send({ type: 'close' });
    } catch {
      // Ignore errors on close
    } finally {
      this.#closed = true;
      this.#drainPending(new Error('SessionIndexWorkerClient is closed'));
      await this.#worker.terminate();
    }
  }
}
