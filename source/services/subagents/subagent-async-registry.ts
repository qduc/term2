import { randomUUID } from 'node:crypto';
import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SubagentRequest, SubagentResult, SubagentRunHandle } from './types.js';
import { SubagentSession } from './subagent-session.js';
import { isAbortLike, safeEmit } from './utils.js';

export type SubagentRegistryErrorCode =
  | 'not_found'
  | 'role_mismatch'
  | 'not_continuable'
  | 'already_active'
  | 'worker_blocked'
  | 'evicted';

export class SubagentRegistryError extends Error {
  readonly code: SubagentRegistryErrorCode;
  constructor(code: SubagentRegistryErrorCode, message: string) {
    super(message);
    this.name = 'SubagentRegistryError';
    this.code = code;
  }
}

type StoredRun = {
  runId: string;
  role: string;
  task: string;
  session: SubagentSession;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: SubagentResult;
  abortController: AbortController;
  lastUsedAt: number;
  resolve: (result: SubagentResult) => void;
  promise: Promise<SubagentResult>;
};

export interface SubagentAsyncRegistryDeps {
  logger: ILoggingService;
  run: (params: {
    request: SubagentRequest;
    runId: string;
    session: SubagentSession;
    signal: AbortSignal;
  }) => Promise<SubagentResult>;
  onEvent?: (event: ConversationEvent) => void;
  now?: () => number;
  ttlMs?: number;
  messageCap?: number;
  sessionForRole?: (role: string) => SubagentSession | undefined;
}

/** Owns async subagent sessions, terminal records, continuation policy and retention. */
export class SubagentAsyncRegistry {
  #logger: ILoggingService;
  #run: SubagentAsyncRegistryDeps['run'];
  #onEvent?: (event: ConversationEvent) => void;
  #runs = new Map<string, StoredRun>();
  #sessions = new Map<string, SubagentSession>();
  #evicted = new Set<string>();
  #now: () => number;
  #ttlMs: number;
  #messageCap: number;
  #sessionForRole?: (role: string) => SubagentSession | undefined;
  #timer: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(deps: SubagentAsyncRegistryDeps) {
    this.#logger = deps.logger;
    this.#run = deps.run;
    this.#onEvent = deps.onEvent;
    this.#now = deps.now ?? Date.now;
    this.#ttlMs = deps.ttlMs ?? 30 * 60 * 1000;
    this.#messageCap = deps.messageCap ?? 50;
    this.#sessionForRole = deps.sessionForRole;
    this.#timer = setInterval(() => this.#evictExpired(), Math.max(1000, Math.min(this.#ttlMs, 60_000)));
    this.#timer.unref?.();
  }

  startRun(request: SubagentRequest, _legacyParentSignal?: AbortSignal): SubagentRunHandle {
    if (this.#disposed) throw new Error('Subagent async registry is disposed');
    const role = request.role;
    if (!['explorer', 'worker', 'researcher', 'mentor', 'librarian'].includes(role)) {
      throw new SubagentRegistryError('not_continuable', `Unknown subagent role: ${role}`);
    }
    const continuation = request.continueRunId;
    let session: SubagentSession;
    if (continuation) {
      const previous = this.#runs.get(continuation);
      if (!previous) {
        throw new SubagentRegistryError(
          this.#evicted.has(continuation) ? 'evicted' : 'not_found',
          `Async subagent run not found: ${continuation}`,
        );
      }
      if (previous.role !== role)
        throw new SubagentRegistryError(
          'role_mismatch',
          `Run ${continuation} belongs to role ${previous.role}, not ${role}`,
        );
      if (previous.status === 'running')
        throw new SubagentRegistryError('already_active', `Async subagent run ${continuation} is already active`);
      if (role === 'worker')
        throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
      if (role !== 'mentor' && role !== 'librarian' && role !== 'explorer' && role !== 'researcher') {
        throw new SubagentRegistryError('not_continuable', `Role ${role} cannot be continued`);
      }
      session = previous.session;
    } else {
      const reuseDefault = role === 'mentor' || role === 'librarian';
      const key = reuseDefault ? `role:${role}` : randomUUID();
      session = this.#sessionForRole?.(role) ?? this.#sessions.get(key) ?? new SubagentSession(key, role);
      this.#sessions.set(key, session);
    }

    const runId = continuation ?? randomUUID();
    const controller = new AbortController();
    let resolve!: (result: SubagentResult) => void;
    const promise = new Promise<SubagentResult>((r) => (resolve = r));
    const stored: StoredRun = {
      runId,
      role,
      task: request.task,
      session,
      status: 'running',
      abortController: controller,
      lastUsedAt: this.#now(),
      resolve,
      promise,
    };
    this.#runs.set(runId, stored);
    safeEmit(this.#logger, this.#onEvent, {
      type: 'subagent_started',
      agentId: runId,
      role,
      task: request.task,
      parentTool: request.parentTool ?? 'run_subagent_async',
      async: true,
    });
    void this.#execute(stored, request);
    return { runId, role, status: 'running', task: request.task } as SubagentRunHandle;
  }

  getResult(runId: string, signal?: AbortSignal): Promise<SubagentResult> {
    const run = this.#runs.get(runId);
    if (!run)
      return Promise.reject(
        new SubagentRegistryError(
          this.#evicted.has(runId) ? 'evicted' : 'not_found',
          `Async subagent run not found: ${runId}`,
        ),
      );
    run.lastUsedAt = this.#now();
    if (run.result) return Promise.resolve(run.result);
    if (signal?.aborted) return Promise.reject(new Error('The get_subagent_result call was aborted.'));
    return run.promise;
  }

  abortRun(runId: string): void {
    const run = this.#runs.get(runId);
    if (run?.status === 'running') run.abortController.abort();
  }

  cancelAllRuns(): void {
    for (const run of this.#runs.values()) if (run.status === 'running') run.abortController.abort();
  }

  reset(): void {
    for (const run of this.#runs.values()) if (run.status === 'running') run.abortController.abort();
    this.#runs.clear();
    this.#sessions.clear();
    this.#evicted.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#timer);
    this.reset();
  }

  #evictExpired(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, run] of this.#runs) {
      if (run.status !== 'running' && run.lastUsedAt <= cutoff) {
        this.#runs.delete(id);
        this.#evicted.add(id);
      }
    }
  }

  async #execute(run: StoredRun, request: SubagentRequest): Promise<void> {
    let result: SubagentResult;
    try {
      result = await this.#run({ request, runId: run.runId, session: run.session, signal: run.abortController.signal });
      run.session.trimHistory(this.#messageCap);
      result = { ...result, agentId: run.runId };
    } catch (error: any) {
      const cancelled = isAbortLike(error?.message, error) || run.abortController.signal.aborted;
      result = {
        agentId: run.runId,
        role: run.role,
        status: cancelled ? 'cancelled' : 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message ?? String(error),
      };
    }
    run.status = result.status;
    run.result = result;
    run.lastUsedAt = this.#now();
    run.resolve(result);
    safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result, async: true });
  }
}
