import { randomUUID } from 'node:crypto';
import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SubagentRequest, SubagentResult, SubagentRunHandle } from './types.js';
import { SubagentSession } from './subagent-session.js';
import { isAbortLike, safeEmit, createCompositeAbortSignal, createAbortError } from './utils.js';

export interface SubagentAsyncRegistryDeps {
  logger: ILoggingService;
  /**
   * Execute a single subagent run. The executor is responsible for role
   * resolution, tool provisioning, and provider streaming. The registry owns
   * the session and lifecycle around this call.
   */
  run: (params: { request: SubagentRequest; runId: string; signal?: AbortSignal }) => Promise<SubagentResult>;
  onEvent?: (event: ConversationEvent) => void;
}

/**
 * Phase 1 async subagent registry. Owns the lifecycle of background subagent
 * runs: starts them, stores a live SubagentSession per run, exposes a handle
 * with a completion promise, and lets callers retrieve results later.
 *
 * Supported roles: explorer, researcher, mentor.
 */
export class SubagentAsyncRegistry {
  #logger: ILoggingService;
  #run: SubagentAsyncRegistryDeps['run'];
  #onEvent?: (event: ConversationEvent) => void;
  #runs = new Map<string, SubagentRunHandle>();
  #masterAbortController = new AbortController();

  constructor(deps: SubagentAsyncRegistryDeps) {
    this.#logger = deps.logger;
    this.#run = deps.run;
    this.#onEvent = deps.onEvent;
  }

  /**
   * Start an asynchronous subagent run.
   *
   * Returns a handle immediately. The run executes in the background and can
   * be queried later via `getResult(runId)`. The run is tied to the parent
   * signal: when the parent signal aborts, the run is cancelled.
   *
   * Phase 1 supports only explorer, researcher, and mentor.
   */
  startRun(request: SubagentRequest, parentSignal?: AbortSignal): SubagentRunHandle {
    const runId = randomUUID();
    const abortController = new AbortController();
    const composite = createCompositeAbortSignal(
      parentSignal,
      abortController.signal,
      this.#masterAbortController.signal,
    );
    const signal = composite?.signal;

    const session = new SubagentSession(runId, request.role);

    let resolveCompleted: (result: SubagentResult) => void;
    let rejectCompleted: (error: Error) => void;
    const completed = new Promise<SubagentResult>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    const handle: SubagentRunHandle = {
      runId,
      role: request.role,
      task: request.task,
      status: 'running',
      session,
      abortController,
      completed,
    };

    this.#runs.set(runId, handle);

    if (signal?.aborted) {
      this.#terminateEarly(
        handle,
        createAbortError('The async subagent run was aborted before it started.'),
        rejectCompleted!,
        'cancelled',
      );
      safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: handle.result!, async: true });
      composite?.cleanup();
      return handle;
    }

    const validationError = this.#validateRole(request.role);
    if (validationError) {
      this.#terminateEarly(handle, new Error(validationError), rejectCompleted!, 'failed');
      safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: handle.result!, async: true });
      composite?.cleanup();
      return handle;
    }

    safeEmit(this.#logger, this.#onEvent, {
      type: 'subagent_started',
      agentId: runId,
      role: request.role,
      task: request.task,
      parentTool: 'run_subagent_async',
      async: true,
    });

    this.#execute(handle, request, signal)
      .then((result) => {
        const terminalResult = { ...result, agentId: runId };
        handle.status = 'completed';
        handle.result = terminalResult;
        resolveCompleted!(terminalResult);
        safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: terminalResult, async: true });
        safeEmit(this.#logger, this.#onEvent, {
          type: 'subagent_async_progress',
          runId,
          role: request.role,
          status: 'completed',
        });
      })
      .catch((error) => {
        const isAbort = isAbortLike(error?.message, error);
        this.#failHandle(
          handle,
          error instanceof Error ? error : new Error(String(error)),
          isAbort ? 'cancelled' : 'failed',
          rejectCompleted!,
        );
        safeEmit(this.#logger, this.#onEvent, { type: 'subagent_completed', result: handle.result!, async: true });
        safeEmit(this.#logger, this.#onEvent, {
          type: 'subagent_async_progress',
          runId,
          role: request.role,
          status: isAbort ? 'cancelled' : 'failed',
          message: handle.error,
        });
      })
      .finally(() => {
        composite?.cleanup();
      });

    return handle;
  }

  /**
   * Retrieve the result of a previously started async run.
   *
   * Resolves when the run completes. Rejects if the runId is unknown or the
   * run was aborted.
   */
  getResult(runId: string, signal?: AbortSignal): Promise<SubagentResult> {
    const handle = this.#runs.get(runId);
    if (!handle) {
      return Promise.reject(new Error(`Unknown async subagent run: ${runId}`));
    }

    if (signal?.aborted) {
      return Promise.reject(createAbortError('The get_subagent_result call was aborted.'));
    }

    if (handle.status === 'completed' && handle.result) {
      return Promise.resolve(handle.result);
    }

    if (handle.status === 'failed' || handle.status === 'cancelled') {
      return Promise.reject(new Error(handle.error || `Async subagent run ${runId} ${handle.status}`));
    }

    return handle.completed;
  }

  /**
   * Look up a live run handle without waiting for completion.
   */
  getRun(runId: string): SubagentRunHandle | undefined {
    return this.#runs.get(runId);
  }

  /**
   * Cancel a specific async run.
   */
  cancelRun(runId: string): void {
    const handle = this.#runs.get(runId);
    if (handle) {
      handle.abortController.abort();
    }
  }

  /**
   * Cancel every running async run. Phase 1 runs are scoped to a single
   * parent turn, so this is called when the parent turn ends.
   */
  cancelAllRuns(): void {
    for (const handle of this.#runs.values()) {
      if (handle.status === 'running') {
        handle.abortController.abort();
      }
    }
  }

  /**
   * Abort all active runs and prevent new ones from starting.
   */
  dispose(): void {
    this.#masterAbortController.abort();
    for (const handle of this.#runs.values()) {
      if (handle.status === 'running') {
        handle.abortController.abort();
      }
    }
  }

  #validateRole(role: string): string | undefined {
    const phase1Roles: readonly string[] = ['explorer', 'researcher', 'mentor'];
    if (!phase1Roles.includes(role)) {
      if (['worker', 'librarian'].includes(role)) {
        return `Async subagent role "${role}" is not supported in Phase 1. Supported roles: explorer, researcher, mentor.`;
      }
      return `Unknown subagent role: "${role}". No definition found.`;
    }
    return undefined;
  }

  async #execute(handle: SubagentRunHandle, request: SubagentRequest, signal?: AbortSignal): Promise<SubagentResult> {
    return this.#run({ request, runId: handle.runId, signal });
  }

  #terminateEarly(
    handle: SubagentRunHandle,
    error: Error,
    rejectCompleted: (error: Error) => void,
    status: 'failed' | 'cancelled',
  ): void {
    this.#failHandle(handle, error, status, rejectCompleted);
  }

  #failHandle(
    handle: SubagentRunHandle,
    error: Error,
    status: 'failed' | 'cancelled',
    rejectCompleted?: (error: Error) => void,
  ): void {
    handle.status = status;
    handle.error = error.message;
    handle.result = {
      agentId: handle.runId,
      role: handle.role,
      status,
      finalText: '',
      filesChanged: [],
      toolsUsed: [],
      error: error.message,
    };
    rejectCompleted?.(error);
  }
}
