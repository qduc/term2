import { randomUUID } from 'node:crypto';
import type { ModelError } from '../model/index.js';
import type { InteractionDecision, InteractionRequestId } from '../tools/index.js';
import type { AnswerResult } from './direct-types.js';
import { DirectBackgroundInteractions } from './direct-background-interactions.js';
import { directTaskAbortError, directTaskError } from './direct-background-types.js';
import type {
  DirectBackgroundFact,
  DirectBackgroundSink,
  DirectTaskContext,
  DirectTaskControlResult,
  DirectTaskDescriptor,
  DirectTaskHandle,
  DirectTaskId,
  DirectTaskMode,
  DirectTaskResult,
  DirectTaskStart,
  DirectTaskState,
} from './direct-background-types.js';

type Entry = {
  readonly task: DirectTaskDescriptor;
  readonly controller: AbortController;
  readonly result: Promise<DirectTaskResult>;
  readonly resolve: (result: DirectTaskResult) => void;
  readonly backgrounded: Promise<void>;
  readonly releaseForeground: () => void;
  mode: DirectTaskMode;
  status: 'running' | 'cancelling' | DirectTaskResult['kind'];
  lastActivityAt: number;
  completedAt?: number;
  outcome?: DirectTaskResult;
  detachParent?: () => void;
};
export type DirectForegroundResult<Value = unknown> =
  | { readonly kind: 'finished'; readonly result: DirectTaskResult<Value> }
  | { readonly kind: 'background'; readonly taskId: DirectTaskId };

/**
 * One Session's live physical task ownership, not an execution loop or writer.
 * The injected operation owns execution/cleanup and its individual tool-start
 * gates. This helper accepts lifecycle and interaction decisions before making
 * them effective. Background work survives its launching foreground turn.
 */
export class DirectBackgroundTasks {
  readonly #sessionId: string;
  readonly #sink: DirectBackgroundSink;
  readonly #now: () => number;
  readonly #entries = new Map<DirectTaskId, Entry>();
  readonly #interactions: DirectBackgroundInteractions;
  #failure?: ModelError;
  #closed = false;

  constructor(options: {
    readonly sessionId: string;
    readonly sink: DirectBackgroundSink;
    readonly now?: () => number;
  }) {
    this.#sessionId = options.sessionId;
    this.#sink = options.sink;
    this.#now = options.now ?? Date.now;
    this.#interactions = new DirectBackgroundInteractions((fact) => this.#accept(fact));
  }

  /** Admit before invoking the body. Values/outcomes must be serializable Session data. */
  start<Value>(
    request: DirectTaskStart,
    operation: (context: DirectTaskContext) => Promise<DirectTaskResult<Value>>,
  ): DirectTaskHandle<Value> {
    this.#assertOpen();
    this.#validateName(request.name);
    if (request.parentSignal?.aborted) throw directTaskAbortError();
    const entry = this.#createEntry(request);
    this.#entries.set(entry.task.taskId, entry);
    try {
      this.#accept({ type: 'task_started', task: entry.task, mode: entry.mode });
    } catch (error) {
      this.#entries.delete(entry.task.taskId);
      throw error;
    }
    this.#linkParent(entry, request.parentSignal);
    // A microtask lets the caller obtain its stable handle before the first body.
    void this.#execute(entry, operation);
    return { taskId: entry.task.taskId, result: entry.result as Promise<DirectTaskResult<Value>> };
  }

  /** Active tasks first; terminal results remain queryable for this Session's lifetime. */
  list(): readonly DirectTaskState[] {
    return [...this.#entries.values()]
      .sort((a, b) => Number(a.outcome !== undefined) - Number(b.outcome !== undefined))
      .map((entry) => this.#state(entry));
  }

  /** Canonical IDs take precedence over aliases; aliases address active tasks only. */
  get(target: string): DirectTaskState | undefined {
    const entry = this.#resolve(target);
    return entry && this.#state(entry);
  }

  /** Await the same owned operation; an aborted waiter never cancels that operation. */
  async wait(target: string, signal: AbortSignal): Promise<DirectTaskState | undefined> {
    signal.throwIfAborted();
    const entry = this.#resolve(target);
    if (!entry) return undefined;
    if (entry.outcome) return this.#state(entry);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        detach();
        reject(directTaskAbortError());
      };
      const detach = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      entry.result.then(
        () => {
          detach();
          resolve();
        },
        (error) => {
          detach();
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
    return this.#state(entry);
  }

  /** All task interactions, independently of the foreground Turn's lifetime. */
  pendingInteractions() {
    return this.#interactions.pending();
  }

  /** Session routes background answers here after selecting this exact request ID. */
  answer(requestId: InteractionRequestId, decision: InteractionDecision): AnswerResult {
    if (this.#failure) return { kind: 'failed', error: this.#failure };
    return this.#interactions.answer(requestId, decision);
  }

  /** Transfer the same live operation, signal, pending pauses and result; never restart. */
  moveToBackground(target: string): DirectTaskControlResult {
    this.#assertOpen();
    const entry = this.#resolve(target);
    if (!entry) return { ok: false, code: 'not_found' };
    if (entry.outcome || entry.status === 'cancelling') return { ok: false, code: 'not_active' };
    if (entry.mode === 'background') return { ok: false, code: 'already_background' };
    this.#accept({ type: 'task_backgrounded', taskId: entry.task.taskId, at: this.#now() });
    entry.mode = 'background';
    entry.detachParent?.();
    entry.detachParent = undefined;
    entry.releaseForeground();
    return { ok: true, task: this.#state(entry) };
  }

  /** Wait for actual settlement or ownership transfer, not for a duplicate execution. */
  async waitForForeground<Value>(handle: DirectTaskHandle<Value>): Promise<DirectForegroundResult<Value>> {
    const entry = this.#entries.get(handle.taskId);
    if (!entry) throw new Error('Task is not owned by this Session.');
    if (entry.outcome) return { kind: 'finished', result: entry.outcome as DirectTaskResult<Value> };
    if (entry.mode === 'background') return { kind: 'background', taskId: handle.taskId };
    return Promise.race([
      entry.result.then(
        (result): DirectForegroundResult<Value> => ({ kind: 'finished', result: result as DirectTaskResult<Value> }),
      ),
      entry.backgrounded.then((): DirectForegroundResult<Value> => ({ kind: 'background', taskId: handle.taskId })),
    ]);
  }

  /** Acknowledge a stop, but retain cancelling until the admitted operation cleans up. */
  requestStop(target: string): DirectTaskControlResult {
    if (this.#failure) throw this.#failure;
    const entry = this.#resolve(target);
    if (!entry) return { ok: false, code: 'not_found' };
    if (entry.outcome || entry.status === 'cancelling') return { ok: false, code: 'not_active' };
    this.#accept({ type: 'task_stop_requested', taskId: entry.task.taskId, at: this.#now() });
    entry.status = 'cancelling';
    // Close waits explicitly; do not rely on throwing from an AbortSignal listener.
    this.#interactions.cancelTask(entry.task.taskId);
    entry.controller.abort();
    return { ok: true, task: this.#state(entry) };
  }

  /** Stop admission, cancel owned tasks, and wait without a forced-idle deadline. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      if (entry.outcome || entry.status === 'cancelling') continue;
      try {
        this.requestStop(entry.task.taskId);
      } catch (error) {
        this.poison(error);
      }
    }
    await Promise.all([...this.#entries.values()].map((entry) => entry.result));
  }

  /** Shared writer failure must also revoke every task capability, without appending. */
  poison(error: unknown): void {
    if (this.#failure) return;
    this.#failure = directTaskError(error);
    this.#interactions.poison(new Error(this.#failure.message));
    for (const entry of this.#entries.values()) {
      if (entry.outcome) continue;
      entry.status = 'cancelling';
      entry.controller.abort();
    }
    this.#sink.failed(this.#failure);
  }

  #createEntry(request: DirectTaskStart): Entry {
    const taskId = randomUUID() as DirectTaskId;
    if (this.#entries.has(taskId)) throw new Error('Task ID collision.');
    const startedAt = this.#now();
    const task: DirectTaskDescriptor = structuredClone({
      taskId,
      sessionId: this.#sessionId,
      kind: request.kind,
      label: request.label,
      ...(request.input !== undefined ? { input: request.input } : {}),
      name: request.name,
      role: request.role,
      model: request.model,
      workspace: request.workspace,
      parentTurnId: request.parentTurnId,
      parentExecutionId: request.parentExecutionId,
      sourceCallId: request.sourceCallId,
      origin: request.origin,
      startedAt,
    });
    let resolve!: Entry['resolve'];
    let releaseForeground!: () => void;
    const result = new Promise<DirectTaskResult>((done) => {
      resolve = done;
    });
    const backgrounded = new Promise<void>((done) => {
      releaseForeground = done;
    });
    return {
      task,
      controller: new AbortController(),
      result,
      resolve,
      backgrounded,
      releaseForeground,
      mode: request.mode,
      status: 'running',
      lastActivityAt: startedAt,
    };
  }

  #linkParent(entry: Entry, signal?: AbortSignal): void {
    if (entry.mode !== 'foreground' || !signal) return;
    const abort = () => {
      try {
        this.requestStop(entry.task.taskId);
      } catch (error) {
        this.poison(error);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    entry.detachParent = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }

  async #execute<Value>(
    entry: Entry,
    operation: (context: DirectTaskContext) => Promise<DirectTaskResult<Value>>,
  ): Promise<void> {
    await Promise.resolve();
    let result: DirectTaskResult;
    try {
      result = entry.controller.signal.aborted ? { kind: 'cancelled' } : await operation(this.#context(entry));
    } catch (error) {
      const failure = directTaskError(error);
      const aborted = error instanceof Error && error.name === 'AbortError';
      result =
        failure.kind === 'cancelled' || (entry.controller.signal.aborted && aborted)
          ? { kind: 'cancelled' }
          : { kind: 'failed', error: failure };
    }
    // Record known outcomes even after cancellation; abort alone proves no terminal.
    this.#finish(entry, result);
  }

  #context(entry: Entry): DirectTaskContext {
    return {
      task: structuredClone(entry.task),
      signal: entry.controller.signal,
      progress: (chunk, kind = 'text', executionId) => {
        if (entry.controller.signal.aborted || entry.outcome || this.#failure) return;
        const at = this.#now();
        try {
          this.#sink.publish({ type: 'task_progress', taskId: entry.task.taskId, at, kind, chunk, executionId });
          entry.lastActivityAt = at;
        } catch (error) {
          this.poison(error);
          throw error;
        }
      },
      interact: (input) => {
        if (entry.outcome || this.#failure)
          return Promise.reject(new Error('Task is no longer accepting interactions.'));
        return this.#interactions.open(
          {
            ...input,
            requestId: input.requestId ?? this.#interactions.createId(),
            turnId: input.turnId ?? entry.task.parentTurnId,
            parentExecutionId: input.parentExecutionId ?? entry.task.parentExecutionId,
            taskId: entry.task.taskId,
            sessionId: this.#sessionId,
            origin: entry.task.origin,
          },
          entry.controller.signal,
        );
      },
    };
  }

  #finish(entry: Entry, observed: DirectTaskResult): void {
    const completedAt = this.#now();
    let result: DirectTaskResult =
      entry.controller.signal.aborted && observed.kind === 'completed'
        ? { kind: 'cancelled', value: observed.value }
        : observed;
    try {
      if (!this.#failure) {
        this.#interactions.cancelTask(entry.task.taskId, 'interrupted');
        this.#accept({ type: 'task_finished', taskId: entry.task.taskId, at: completedAt, result });
      }
    } catch (error) {
      this.poison(error);
    }
    if (this.#failure) result = { kind: 'failed', error: this.#failure, value: observed.value };
    entry.outcome = result;
    entry.status = result.kind;
    entry.completedAt = completedAt;
    entry.detachParent?.();
    entry.detachParent = undefined;
    entry.resolve(result);
  }

  #state(entry: Entry): DirectTaskState {
    const pendingInteractions = this.#interactions.pending(entry.task.taskId);
    return structuredClone({
      ...entry.task,
      mode: entry.mode,
      status: entry.status === 'running' && pendingInteractions.length ? 'waiting_for_answer' : entry.status,
      lastActivityAt: entry.lastActivityAt,
      completedAt: entry.completedAt,
      result: entry.outcome,
      pendingInteractions,
    });
  }

  #resolve(target: string): Entry | undefined {
    return (
      this.#entries.get(target as DirectTaskId) ??
      [...this.#entries.values()].find((entry) => entry.task.name === target && !entry.outcome)
    );
  }

  #validateName(name?: string): void {
    if (name === undefined) return;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Invalid task name.');
    if (this.#resolve(name)) throw new Error('Task name already in use.');
  }

  #assertOpen(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new Error('Session task admission is closed.');
  }

  #accept(fact: DirectBackgroundFact): void {
    if (this.#failure) throw this.#failure;
    try {
      this.#sink.accept(fact);
    } catch (error) {
      this.poison(error);
      throw error;
    }
  }
}
