import { randomUUID } from 'node:crypto';
import type { BackgroundTaskObservation } from '../background-task-activity.js';

export type BackgroundShellJobStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
export type BackgroundShellTerminalStatus = Extract<
  BackgroundShellJobStatus,
  'completed' | 'failed' | 'timed_out' | 'cancelled'
>;

export interface BackgroundShellJob<TResult> {
  id: string;
  command: string;
  status: BackgroundShellJobStatus;
  startedAt: number;
  completedAt?: number;
  result?: TResult;
  error?: string;
  /** Last registry-observed start or output-chunk timestamp. */
  lastActivityAt?: number;
  /** Last bounded event the local shell registry observed. */
  lastObservation?: BackgroundTaskObservation;
}

export interface BackgroundShellLaunch<TResult> extends BackgroundShellJob<TResult> {
  /** Resolves after the command and its per-job cleanup have both settled. */
  settled: Promise<BackgroundShellJob<TResult>>;
}

export interface BackgroundShellLaunchOptions<TResult> {
  command: string;
  /** The registry creates this signal so cancellation has one owner. */
  run: (signal: AbortSignal) => Promise<TResult>;
  /** Called after registration and before the runner starts. */
  onStarted?: (jobId: string) => void;
  /** Releases resources that must remain live until the process settles. */
  onSettled?: () => Promise<void> | void;
  /** Lets the launcher preserve a successful process result that timed out. */
  resultToStatus?: (result: TResult) => Exclude<BackgroundShellTerminalStatus, 'cancelled'>;
}

/** A running root-shell invocation that can be transferred to this registry. */
export interface ForegroundShellLease<TResult> {
  /** The original root tool call which may request the transfer. */
  callId: string;
  /** The preallocated background-job ID, stable across adoption. */
  jobId: string;
  command: string;
  startedAt: number;
  status: 'running';
  /** Resolves to the normal tool result, or the adopted job handle after transfer. */
  foregroundResult: Promise<TResult | ForegroundShellTransferResult>;
  /** Resolves only after the one process and its cleanup have settled. */
  settled: Promise<BackgroundShellJob<TResult>>;
}

export interface ForegroundShellLeaseOptions<TResult> extends BackgroundShellLaunchOptions<TResult> {
  callId: string;
  /** The foreground turn owns this signal until the lease is adopted. */
  parentSignal?: AbortSignal;
  /** Observational transfer hand-off, invoked before the foreground result resolves. */
  onAdopted?: () => void;
}

export interface ForegroundShellTransferResult {
  jobId: string;
  status: 'running';
}

export interface ForegroundShellLeaseDetails {
  callId: string;
  jobId: string;
  command: string;
  status: 'running';
  startedAt: number;
}

export interface BackgroundShellRegistryOptions<TResult = unknown> {
  maxConcurrentJobs?: number;
  maxRetainedJobs?: number;
  createId?: () => string;
  now?: () => number;
  onEvent?: BackgroundShellEventSink<TResult>;
}

export type BackgroundShellEvent<TResult> =
  | { type: 'background_shell_started'; jobId: string; command: string }
  | {
      type: 'background_shell_completed';
      jobId: string;
      command: string;
      status: BackgroundShellTerminalStatus;
      output?: TResult;
      error?: string;
    }
  | {
      /** One watch firing for a job that may still be running. */
      type: 'background_shell_output';
      jobId: string;
      command: string;
      watchId: string;
      /** Per-watch monotonic firing ordinal; the notification messageId dedupe key. */
      seq: number;
      /** Bounded, complete-line match text carried by the firing. */
      matchedLines: string;
      /** Distinct complete lines coalesced into this firing (incl. byte-cap evictions). */
      coalescedCount?: number;
      /** Inclusive per-watch seq range this firing represents. */
      seqRange?: { first: number; last: number };
      /** Present when the job's retained buffer evicted bytes before this firing. */
      droppedBytes?: number;
    };

/** Observational only: failures must not interfere with job lifecycle. */
export type BackgroundShellEventSink<TResult> = (event: BackgroundShellEvent<TResult>) => void;

export class BackgroundShellRegistryCapacityError extends Error {
  constructor(maxConcurrentJobs: number) {
    super(`Background shell job limit reached (${maxConcurrentJobs}).`);
    this.name = 'BackgroundShellRegistryCapacityError';
  }
}

export class BackgroundShellRegistryDisposedError extends Error {
  constructor() {
    super('Background shell registry has been disposed.');
    this.name = 'BackgroundShellRegistryDisposedError';
  }
}

interface JobRecord<TResult> {
  job: BackgroundShellJob<TResult>;
  controller: AbortController;
  settled: Promise<BackgroundShellJob<TResult>>;
}

interface ForegroundRecord<TResult> extends JobRecord<TResult> {
  callId: string;
  detachParentAbort: () => void;
  adopted: boolean;
  onAdopted?: () => void;
  resolveForegroundResult: (result: TResult | ForegroundShellTransferResult) => void;
  rejectForegroundResult: (error: unknown) => void;
}

/**
 * Session-owned lifecycle for shell processes whose tool invocation has
 * already returned. The registry deliberately owns cancellation and retention
 * so callers cannot accidentally leave an orphaned process behind.
 */
export class BackgroundShellRegistry<TResult> {
  readonly #jobs = new Map<string, JobRecord<TResult>>();
  readonly #foreground = new Map<string, ForegroundRecord<TResult>>();
  readonly #terminalJobIds: string[] = [];
  readonly #maxConcurrentJobs: number;
  readonly #maxRetainedJobs: number;
  readonly #createId: () => string;
  readonly #now: () => number;
  #eventSink: BackgroundShellEventSink<TResult> | undefined;
  #runningJobs = 0;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: BackgroundShellRegistryOptions<TResult> = {}) {
    this.#maxConcurrentJobs = options.maxConcurrentJobs ?? 4;
    this.#maxRetainedJobs = options.maxRetainedJobs ?? 20;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#eventSink = options.onEvent;
    if (!Number.isInteger(this.#maxConcurrentJobs) || this.#maxConcurrentJobs < 1) {
      throw new RangeError('maxConcurrentJobs must be a positive integer.');
    }
    if (!Number.isInteger(this.#maxRetainedJobs) || this.#maxRetainedJobs < 0) {
      throw new RangeError('maxRetainedJobs must be a non-negative integer.');
    }
  }

  launch(options: BackgroundShellLaunchOptions<TResult>): BackgroundShellLaunch<TResult> {
    if (this.#disposed) throw new BackgroundShellRegistryDisposedError();
    if (this.#runningJobs >= this.#maxConcurrentJobs) {
      throw new BackgroundShellRegistryCapacityError(this.#maxConcurrentJobs);
    }

    const job: BackgroundShellJob<TResult> = {
      id: this.#createId(),
      command: options.command,
      status: 'running',
      startedAt: this.#now(),
    };
    job.lastActivityAt = job.startedAt;
    job.lastObservation = { kind: 'shell_started', at: job.startedAt };
    const controller = new AbortController();
    this.#runningJobs += 1;
    const record: JobRecord<TResult> = {
      job,
      controller,
      settled: Promise.resolve(job),
    };
    this.#jobs.set(job.id, record);
    options.onStarted?.(job.id);
    record.settled = this.#settle(record, options);
    this.#emit({ type: 'background_shell_started', jobId: job.id, command: job.command });

    return { ...job, settled: record.settled };
  }

  /**
   * Starts a root shell process under a detachable foreground lease. The lease
   * is intentionally invisible to `list()` until `adoptForeground` succeeds.
   */
  startForeground(options: ForegroundShellLeaseOptions<TResult>): ForegroundShellLease<TResult> {
    if (this.#disposed) throw new BackgroundShellRegistryDisposedError();
    if (this.#foreground.has(options.callId)) {
      throw new Error(`Foreground shell lease already exists for tool call ${options.callId}.`);
    }

    const job: BackgroundShellJob<TResult> = {
      id: this.#createId(),
      command: options.command,
      status: 'running',
      startedAt: this.#now(),
    };
    job.lastActivityAt = job.startedAt;
    job.lastObservation = { kind: 'shell_started', at: job.startedAt };
    const controller = new AbortController();
    let resolveForegroundResult!: (result: TResult | ForegroundShellTransferResult) => void;
    let rejectForegroundResult!: (error: unknown) => void;
    const foregroundResult = new Promise<TResult | ForegroundShellTransferResult>((resolve, reject) => {
      resolveForegroundResult = resolve;
      rejectForegroundResult = reject;
    });
    const abortFromParent = () => controller.abort();
    if (options.parentSignal?.aborted) abortFromParent();
    else options.parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const record: ForegroundRecord<TResult> = {
      job,
      controller,
      callId: options.callId,
      adopted: false,
      onAdopted: options.onAdopted,
      detachParentAbort: () => options.parentSignal?.removeEventListener('abort', abortFromParent),
      resolveForegroundResult,
      rejectForegroundResult,
      settled: Promise.resolve(job),
    };
    this.#foreground.set(options.callId, record);
    options.onStarted?.(job.id);
    record.settled = this.#settleForeground(record, options);
    return {
      callId: record.callId,
      jobId: job.id,
      command: job.command,
      startedAt: job.startedAt,
      status: 'running',
      foregroundResult,
      settled: record.settled,
    };
  }

  getForeground(callId: string): ForegroundShellLeaseDetails | undefined {
    const record = this.#foreground.get(callId);
    if (!record || record.job.status !== 'running') return undefined;
    return {
      callId: record.callId,
      jobId: record.job.id,
      command: record.job.command,
      status: 'running',
      startedAt: record.job.startedAt,
    };
  }

  listForeground(): ForegroundShellLeaseDetails[] {
    return [...this.#foreground.values()]
      .filter((record) => record.job.status === 'running')
      .map((record) => ({
        callId: record.callId,
        jobId: record.job.id,
        command: record.job.command,
        status: 'running' as const,
        startedAt: record.job.startedAt,
      }));
  }

  /** Atomically publishes a running foreground lease as a background job. */
  adoptForeground(callId: string): ForegroundShellTransferResult {
    const record = this.#foreground.get(callId);
    if (!record || record.job.status !== 'running') {
      throw new Error(`No running foreground shell lease exists for tool call ${callId}.`);
    }
    if (record.controller.signal.aborted) {
      throw new Error(`Foreground shell lease for tool call ${callId} is already aborting.`);
    }
    if (this.#disposed) throw new BackgroundShellRegistryDisposedError();
    if (this.#runningJobs >= this.#maxConcurrentJobs) {
      throw new BackgroundShellRegistryCapacityError(this.#maxConcurrentJobs);
    }

    // All validation precedes this ownership change. JavaScript's synchronous
    // turn makes these mutations atomic with respect to process settlement.
    record.detachParentAbort();
    record.adopted = true;
    this.#foreground.delete(callId);
    this.#jobs.set(record.job.id, record);
    this.#runningJobs += 1;
    const result: ForegroundShellTransferResult = { jobId: record.job.id, status: 'running' };
    try {
      record.onAdopted?.();
    } catch {
      // Lifecycle ownership has already changed; observers cannot roll it back.
    }
    record.resolveForegroundResult(result);
    this.#emit({ type: 'background_shell_started', jobId: record.job.id, command: record.job.command });
    return result;
  }

  get(id: string): BackgroundShellJob<TResult> | undefined {
    const job = this.#jobs.get(id)?.job;
    return job ? { ...job } : undefined;
  }

  whenSettled(id: string): Promise<BackgroundShellJob<TResult>> | undefined {
    return this.#jobs.get(id)?.settled;
  }

  setEventSink(eventSink: BackgroundShellEventSink<TResult> | undefined): void {
    this.#eventSink = eventSink;
  }

  list(): BackgroundShellJob<TResult>[] {
    return [...this.#jobs.values()].map(({ job }) => ({ ...job }));
  }

  cancel(id: string): boolean {
    const record = this.#jobs.get(id);
    if (!record || record.job.status !== 'running') return false;
    record.job.status = 'cancelling';
    record.job.lastActivityAt = this.#now();
    record.job.lastObservation = { kind: 'stop_requested', at: record.job.lastActivityAt };
    record.controller.abort();
    return true;
  }

  /** Records that a running process produced output without retaining the chunk. */
  recordOutputChunk(id: string): boolean {
    const record = this.#jobs.get(id) ?? [...this.#foreground.values()].find((candidate) => candidate.job.id === id);
    if (!record || (record.job.status !== 'running' && record.job.status !== 'cancelling')) return false;
    if (record.job.status !== 'cancelling') {
      record.job.lastActivityAt = this.#now();
      record.job.lastObservation = { kind: 'shell_output_received', at: record.job.lastActivityAt };
    }
    return true;
  }

  /** Cancels every running process and permanently rejects new launches. */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    for (const { job } of this.#jobs.values()) {
      this.cancel(job.id);
    }
    const foreground = [...this.#foreground.values()];
    for (const record of foreground) record.controller.abort();
    this.#disposePromise = Promise.allSettled([
      ...[...this.#jobs.values()].map((record) => record.settled),
      ...foreground.map((record) => record.settled),
    ]).then(() => {});
    return this.#disposePromise;
  }

  async #settle(
    record: JobRecord<TResult>,
    options: BackgroundShellLaunchOptions<TResult>,
  ): Promise<BackgroundShellJob<TResult>> {
    let result: TResult | undefined;
    let failure: unknown;
    try {
      result = await options.run(record.controller.signal);
    } catch (error) {
      failure = error;
    }

    try {
      await options.onSettled?.();
    } catch (error) {
      failure ??= error;
    }

    const { job } = record;
    this.#runningJobs -= 1;
    job.completedAt = this.#now();
    job.lastActivityAt = job.completedAt;
    job.lastObservation = { kind: 'settled', at: job.completedAt };
    if (record.controller.signal.aborted) {
      job.status = 'cancelled';
      if (result !== undefined) job.result = result;
    } else if (failure !== undefined) {
      job.status = 'failed';
      job.error = errorMessage(failure);
    } else {
      job.status = options.resultToStatus?.(result as TResult) ?? 'completed';
      job.result = result as TResult;
    }
    this.#retainTerminal(job.id);
    this.#emit({
      type: 'background_shell_completed',
      jobId: job.id,
      command: job.command,
      status: job.status,
      ...(job.result === undefined ? {} : { output: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
    });
    return { ...job };
  }

  async #settleForeground(
    record: ForegroundRecord<TResult>,
    options: ForegroundShellLeaseOptions<TResult>,
  ): Promise<BackgroundShellJob<TResult>> {
    let result: TResult | undefined;
    let failure: unknown;
    try {
      result = await options.run(record.controller.signal);
    } catch (error) {
      failure = error;
    }

    try {
      await options.onSettled?.();
    } catch (error) {
      failure ??= error;
    }

    const { job } = record;
    job.completedAt = this.#now();
    job.lastActivityAt = job.completedAt;
    job.lastObservation = { kind: 'settled', at: job.completedAt };
    if (record.controller.signal.aborted) {
      job.status = 'cancelled';
      if (result !== undefined) job.result = result;
    } else if (failure !== undefined) {
      job.status = 'failed';
      job.error = errorMessage(failure);
    } else {
      job.status = options.resultToStatus?.(result as TResult) ?? 'completed';
      job.result = result as TResult;
    }

    if (record.adopted) {
      this.#runningJobs -= 1;
      this.#retainTerminal(job.id);
      this.#emit({
        type: 'background_shell_completed',
        jobId: job.id,
        command: job.command,
        status: job.status,
        ...(job.result === undefined ? {} : { output: job.result }),
        ...(job.error === undefined ? {} : { error: job.error }),
      });
    } else {
      record.detachParentAbort();
      this.#foreground.delete(record.callId);
      if (failure !== undefined) record.rejectForegroundResult(failure);
      else record.resolveForegroundResult(result as TResult);
    }
    return { ...job };
  }

  #retainTerminal(id: string): void {
    this.#terminalJobIds.push(id);
    while (this.#terminalJobIds.length > this.#maxRetainedJobs) {
      const evicted = this.#terminalJobIds.shift();
      if (evicted) this.#jobs.delete(evicted);
    }
  }

  #emit(event: BackgroundShellEvent<TResult>): void {
    try {
      this.#eventSink?.(event);
    } catch {
      // Event consumers are observational and must not change process lifetime.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
