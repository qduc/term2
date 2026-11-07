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

/** Prepared execution seam implemented by the live Session shell adapter. */
export interface BackgroundShellRegistryPort<TResult> {
  launch(options: BackgroundShellLaunchOptions<TResult>): BackgroundShellLaunch<TResult>;
  startForeground(options: ForegroundShellLeaseOptions<TResult>): ForegroundShellLease<TResult>;
  get(id: string): BackgroundShellJob<TResult> | undefined;
  list(): BackgroundShellJob<TResult>[];
  cancel(id: string): boolean;
  recordOutputChunk(id: string, stream?: 'stdout' | 'stderr', text?: string): boolean;
}
