import path from 'node:path';
import { getConversationsDir } from '../conversation-persistence.js';
import type { SessionBrowserContext, SessionListInput } from '../session-browser.js';
import { fitSerializedEnvelope, fitsSerializedText, boundedJsonFailure } from '../../../utils/output/bounded-json.js';
import { SessionIndexDatabase, type IndexedResolveResult, type ReconcileResult } from './session-index-database.js';
import { SessionIndexWorkerClient } from './session-index-worker-client.js';

const DEFAULT_INDEX_CHARS = 12_000;
const DEFAULT_LIMIT = 10;

export interface SessionIndexServiceOptions {
  dbPath?: string;
  conversationsDir?: string;
  backend?: 'worker' | 'direct';
  workerClient?: SessionIndexWorkerClient;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string) => void };
}

export function resolveDefaultSessionIndexPath(conversationsDir: string): string {
  if (process.env['TERM2_SESSION_INDEX_PATH']) {
    return process.env['TERM2_SESSION_INDEX_PATH'];
  }
  return path.join(path.dirname(conversationsDir), 'session-index.db');
}

function clamp(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(50, value ?? fallback));
}

function fitted<T extends Record<string, unknown>>(value: T, maxChars: number): T | null {
  const result = fitSerializedEnvelope((charsUsed) => ({ ...value, charsUsed }), { maxChars });
  return (result?.value as T | undefined) ?? null;
}

function outputBudgetError(maxChars: number) {
  const value = {
    error: { code: 'output_budget_exceeded', message: 'The requested result cannot fit in the output budget.' },
  };
  if (fitsSerializedText(JSON.stringify(value), { maxChars })) return value;
  const fallback = boundedJsonFailure({ maxChars });
  return fallback ? JSON.parse(fallback) : 0;
}

export class SessionIndexService {
  readonly #conversationsDir: string;
  readonly #dbPath: string;
  readonly #backend: 'worker' | 'direct';
  readonly #logger?: SessionIndexServiceOptions['logger'];
  #workerClient: SessionIndexWorkerClient | null = null;
  #directDb: SessionIndexDatabase | null = null;
  #probeAttempted = false;
  #available = false;
  #fallbackReason: string | null = null;

  constructor(options?: SessionIndexServiceOptions) {
    this.#conversationsDir = options?.conversationsDir ?? getConversationsDir();
    this.#dbPath = options?.dbPath ?? resolveDefaultSessionIndexPath(this.#conversationsDir);
    this.#backend = options?.backend ?? (options?.workerClient ? 'worker' : 'worker');
    this.#logger = options?.logger;
    if (options?.workerClient) {
      this.#workerClient = options.workerClient;
    }
  }

  isAvailable(): boolean {
    return this.#available;
  }

  getFallbackReason(): string | null {
    return this.#fallbackReason;
  }

  async ensureReady(): Promise<boolean> {
    if (this.#probeAttempted) {
      return this.#available;
    }
    this.#probeAttempted = true;

    try {
      if (this.#backend === 'direct') {
        this.#directDb = new SessionIndexDatabase(this.#dbPath, this.#conversationsDir);
        const probe = this.#directDb.probeCapability();
        if (!probe.ok) {
          this.#available = false;
          this.#fallbackReason = probe.reason;
          this.#logger?.warn('Session query index capability probe failed, falling back to canonical browser', {
            reason: probe.reason,
          });
          return false;
        }
        this.#available = true;
        return true;
      }

      // Worker backend
      if (!this.#workerClient) {
        this.#workerClient = new SessionIndexWorkerClient(this.#dbPath, this.#conversationsDir);
      }
      const probe = await this.#workerClient.probe();
      if (!probe.ok) {
        this.#available = false;
        this.#fallbackReason = probe.reason;
        this.#logger?.warn('Session query index capability probe failed, falling back to canonical browser', {
          reason: probe.reason,
        });
        return false;
      }
      this.#available = true;
      return true;
    } catch (error) {
      this.#available = false;
      this.#fallbackReason = error instanceof Error ? error.message : String(error);
      this.#logger?.warn('Session query index initialization failed, falling back to canonical browser', {
        error: this.#fallbackReason,
      });
      return false;
    }
  }

  async reconcile(): Promise<ReconcileResult> {
    const ready = await this.ensureReady();
    if (!ready) {
      return {
        ok: false,
        replayedCount: 0,
        deletedCount: 0,
        stable: false,
        error: this.#fallbackReason ?? 'Unavailable',
      };
    }

    try {
      if (this.#backend === 'direct' && this.#directDb) {
        return this.#directDb.reconcile();
      }
      return await this.#workerClient!.reconcile();
    } catch (error) {
      this.#logger?.warn('Session query index reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        replayedCount: 0,
        deletedCount: 0,
        stable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async list(context: SessionBrowserContext, input: SessionListInput): Promise<unknown> {
    const ready = await this.ensureReady();
    if (!ready) return null;

    const reconcileResult = await this.reconcile();
    if (!reconcileResult.ok || !reconcileResult.stable) {
      return null; // Fall back to canonical on mid-replay change or error
    }

    const budget = input.maxChars ?? DEFAULT_INDEX_CHARS;
    let indexed;
    try {
      if (this.#backend === 'direct' && this.#directDb) {
        indexed = this.#directDb.list({ projectPath: context.projectPath, sshHost: context.sshHost });
      } else {
        indexed = await this.#workerClient!.list({ projectPath: context.projectPath, sshHost: context.sshHost });
      }
    } catch {
      return null;
    }

    const selected = indexed.sessions.slice(0, clamp(input.limit, DEFAULT_LIMIT));
    const result = {
      sessions: [] as Array<Record<string, unknown>>,
      scope: indexed.scope,
      total: indexed.total,
      omitted: 0,
      unavailable: indexed.unavailable,
    };

    for (const item of selected) {
      const candidate = fitted({ ...result, sessions: [...result.sessions, item], omitted: selected.length }, budget);
      if (candidate) result.sessions = candidate.sessions;
      else result.omitted++;
    }

    return fitted(result, budget) ?? outputBudgetError(budget);
  }

  async resolveReference(reference: string, context: SessionBrowserContext): Promise<IndexedResolveResult | null> {
    const ready = await this.ensureReady();
    if (!ready) return null;

    const reconcileResult = await this.reconcile();
    if (!reconcileResult.ok || !reconcileResult.stable) {
      return null; // Fall back to canonical
    }

    try {
      if (this.#backend === 'direct' && this.#directDb) {
        return this.#directDb.resolveReference(reference, {
          projectPath: context.projectPath,
          sshHost: context.sshHost,
          currentSessionId: context.currentSessionId,
        });
      }
      return await this.#workerClient!.resolveReference(reference, {
        projectPath: context.projectPath,
        sshHost: context.sshHost,
        currentSessionId: context.currentSessionId,
      });
    } catch {
      return null;
    }
  }

  async getRevision(sessionId: string): Promise<string | null> {
    const ready = await this.ensureReady();
    if (!ready) return null;

    try {
      if (this.#backend === 'direct' && this.#directDb) {
        return this.#directDb.getRevision(sessionId);
      }
      return await this.#workerClient!.getRevision(sessionId);
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.#directDb) {
      this.#directDb.close();
      this.#directDb = null;
    }
    if (this.#workerClient) {
      await this.#workerClient.close();
      this.#workerClient = null;
    }
  }
}
