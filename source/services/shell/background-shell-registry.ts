import { randomUUID } from 'node:crypto';

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
}

export interface BackgroundShellLaunch<TResult> extends BackgroundShellJob<TResult> {
  /** Resolves after the command and its per-job cleanup have both settled. */
  settled: Promise<BackgroundShellJob<TResult>>;
}

export interface BackgroundShellLaunchOptions<TResult> {
  command: string;
  /** The registry creates this signal so cancellation has one owner. */
  run: (signal: AbortSignal) => Promise<TResult>;
  /** Releases resources that must remain live until the process settles. */
  onSettled?: () => Promise<void> | void;
  /** Lets the launcher preserve a successful process result that timed out. */
  resultToStatus?: (result: TResult) => Exclude<BackgroundShellTerminalStatus, 'cancelled'>;
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

/**
 * Session-owned lifecycle for shell processes whose tool invocation has
 * already returned. The registry deliberately owns cancellation and retention
 * so callers cannot accidentally leave an orphaned process behind.
 */
export class BackgroundShellRegistry<TResult> {
  readonly #jobs = new Map<string, JobRecord<TResult>>();
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
    const controller = new AbortController();
    this.#runningJobs += 1;
    const record: JobRecord<TResult> = {
      job,
      controller,
      settled: Promise.resolve(job),
    };
    record.settled = this.#settle(record, options);
    this.#jobs.set(job.id, record);
    this.#emit({ type: 'background_shell_started', jobId: job.id, command: job.command });

    return { ...job, settled: record.settled };
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
    record.controller.abort();
    return true;
  }

  /** Cancels every running process and permanently rejects new launches. */
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    for (const { job } of this.#jobs.values()) {
      this.cancel(job.id);
    }
    this.#disposePromise = Promise.allSettled([...this.#jobs.values()].map((record) => record.settled)).then(() => {});
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
