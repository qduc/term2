import type { SettingKey, SettingValue } from './settings/settings-schema.js';

/**
 * Structured metadata contract for application log records (Contract 07, C7.5).
 *
 * Callers pass arbitrary diagnostic keys — `RuntimeLogSchema` passes them
 * through to the winston record — but the fields that drive log behavior are
 * typed explicitly so misuse fails at compile time instead of silently
 * corrupting records: `eventType` gates redaction and category filtering,
 * `correlationId` is the explicit per-call override that beats the ambient
 * process-wide id, and the canonical record fields feed
 * `buildRuntimeLogRecord`. Values are `unknown`-typed (never `any`) so
 * consumers must narrow before reading.
 */
export type LogMetadataContract = {
  eventType?: string;
  correlationId?: string;
  traceId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  messageId?: string;
  category?: string;
  phase?: string;
  direction?: string;
  requestId?: string;
  toolName?: string;
  toolCallId?: string;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
};

export type SessionTrafficContext = {
  sessionId: string;
  sessionStartedAt: string;
  providerHistoryKey?: string;
  mode?: string;
  traceId?: string;
  evaluator?: boolean;
  firstUserMessagePreview?: string;
};

export interface ILoggingService {
  info(message: string, meta?: LogMetadataContract): void;
  warn(message: string, meta?: LogMetadataContract): void;
  error(message: string, meta?: LogMetadataContract): void;
  debug(message: string, meta?: LogMetadataContract): void;
  security(message: string, meta?: LogMetadataContract): void;
  setCorrelationId(id: string | undefined): void;
  getCorrelationId(): string | undefined;
  clearCorrelationId(): void;
  providerTraffic?: IProviderTraffic;
}

export interface ProviderTrafficRequest {
  requestId: string;
  provider: string;
  model: string;
  sentBody: Record<string, unknown>;
  headers?: Record<string, string>;
  modelClass?: string;
  modelWrapperClass?: string;
}

export interface ProviderTrafficResponse {
  requestId: string;
  provider: string;
  model: string;
  status: number;
  response: any; // Response or Record<string, unknown>
  error?: Record<string, unknown>;
  modelClass?: string;
  modelWrapperClass?: string;
  transport?: 'websocket';
  receiveTiming?: ProviderTrafficReceiveTiming;
}

export interface ProviderTrafficClosedResponse {
  requestId: string;
  provider: string;
  model: string;
  /**
   * `'failed'` is a stream that ended because a raw transport `error`/`close`
   * frame was observed before any terminal response event — distinct from
   * `'consumer_closed'`, which is this application choosing to stop reading a
   * still-live stream. Without the distinction, an abnormal WebSocket close
   * (e.g. close code 1006) is indistinguishable from ordinary cleanup.
   */
  outcome: 'consumer_closed' | 'aborted' | 'failed';
  eventCount: number;
  modelClass?: string;
  modelWrapperClass?: string;
  /**
   * A stream that ends without a terminal event leaves no payload to
   * summarize, so the retained transcript and its timings are the only record
   * of what the model was doing when it was cut off. Bounded (no raw event
   * payload) for `'failed'`, since a transport failure is not the deliberate
   * client abort that full transcript retention is for.
   */
  diagnostics?: ProviderTrafficStreamDiagnostics | ProviderTrafficBoundedStreamDiagnostics;
}

/**
 * Fixed, bounded classification of a Responses WebSocket frame's progress
 * kind. Closed union on purpose — see `aborted-stream-recorder.ts`.
 */
export type ProviderTrafficProgressCategory = 'text' | 'reasoning' | 'tool' | 'usage' | 'heartbeat_or_unknown';

export interface ProviderTrafficStreamDiagnostics {
  durationMs: number;
  firstEventMs?: number;
  lastEventMs?: number;
  maxGapMs?: number;
  responseId?: string;
  /** Present only when a raw transport `close` frame was observed. */
  closeCode?: number;
  closeReason?: string;
  eventTypeCounts: Record<string, number>;
  progressCategoryCounts: Record<ProviderTrafficProgressCategory, number>;
  events: unknown[];
}

/**
 * Same shape as {@link ProviderTrafficStreamDiagnostics} minus the raw event
 * transcript. Used where the caller must retain bounded category/counter/
 * timing evidence without retaining unbounded, potentially sensitive frame
 * payloads — in particular a genuine transport failure, which is not a
 * deliberate client abort and can carry an unbounded number of frames.
 */
export type ProviderTrafficBoundedStreamDiagnostics = Omit<ProviderTrafficStreamDiagnostics, 'events'>;

/**
 * What a transport-liveness guard observed while receiving a response, in the
 * same clock it judges expiry with.
 *
 * The budgets travel with the measurements because they are user-configurable:
 * a latency logged without the deadline it was measured against cannot be read
 * back later as margin.
 */
export interface ProviderTrafficReceiveTiming {
  frameCount: number;
  firstFrameBudgetMs: number;
  interFrameBudgetMs: number;
  firstFrameMs?: number;
  maxInterFrameMs?: number;
  waitedMs?: number;
}

export interface IProviderTraffic {
  recordRequestStart(input: ProviderTrafficRequest): void;
  recordResponseReceived(input: ProviderTrafficResponse): Promise<void>;
  recordResponseClosed(input: ProviderTrafficClosedResponse): void;
  recordRequestFailed(input: {
    requestId: string;
    provider: string;
    model: string;
    error: unknown;
    modelClass?: string;
    modelWrapperClass?: string;
    wsAttempt?: number;
    wsMaxAttempts?: number;
    receiveTiming?: ProviderTrafficReceiveTiming;
    /**
     * Bounded category/counter/timing evidence of stream progress observed
     * before the failure, when a stream had already started delivering
     * frames. Absent when the failure happened before any frame arrived.
     */
    diagnostics?: ProviderTrafficBoundedStreamDiagnostics;
  }): void;
}

export interface ISessionContextService {
  runWithContext<T>(context: SessionTrafficContext, fn: () => T): T;
  getContext(): SessionTrafficContext | null;
}

export interface ISettingsService {
  get<K extends SettingKey>(key: K): SettingValue<K>;
  getDynamic(key: string): unknown;
  set<K extends SettingKey>(key: K, value: SettingValue<K>, options?: { persist?: boolean }): void;
  setDynamic(key: string, value: unknown, options?: { persist?: boolean }): void;
  setPersistent<K extends SettingKey>(key: K, value: SettingValue<K>): void;
  setPersistentDynamic(key: string, value: unknown): void;
  onChange?: (listener: (key?: string) => void) => () => void;
}

/**
 * Per-invocation options for a remote command. Absent options preserve the
 * pre-existing behavior: no timeout is armed and no abort listener is
 * attached. Both `timeoutMs` and `signal` are opt-in containment/cancellation
 * levers, not default watchdogs.
 */
export interface SSHCommandOptions {
  /** Remote working directory the command runs in (`cd <cwd> && <cmd>`). */
  cwd?: string;
  /**
   * Opt-in wall-clock bound on how long the caller waits for settlement.
   * When the bound elapses, the pending promise rejects with a typed
   * `SSHTransportError` of kind `'timeout'`; no default is applied when the
   * option is absent. The remote process is NOT killed or replayed — its
   * effect is reported as `'unknown'`.
   */
  timeoutMs?: number;
  /**
   * Opt-in cancellation signal. Aborting settles the pending promise with a
   * typed `SSHTransportError` of kind `'aborted'`; a signal that is already
   * aborted before dispatch rejects with `remoteEffect: 'none'` and sends no
   * command. No default signal is applied when the option is absent.
   */
  signal?: AbortSignal;
}

export interface SSHCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ISSHService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /**
   * Resolves with the remote result on terminal channel close. Rejects with a
   * typed {@link SSHTransportError} (from `source/services/ssh-service.ts`) on
   * pre-dispatch failure (`'not_connected'`, pre-aborted `'aborted'`), exec
   * dispatch failure (`'exec_failed'`), transport drop while in flight
   * (`'connection_error'`, `'connection_end'`, `'connection_close'`,
   * `'channel_error'`), explicit disconnect (`'explicit_disconnect'`),
   * mid-flight abort (`'aborted'`), or elapsed `timeoutMs` (`'timeout'`).
   * Transport-level settlement never claims a safe blind replay: the error
   * carries `remoteEffect: 'unknown'` when the remote process may have run.
   */
  executeCommand(cmd: string, opts?: SSHCommandOptions): Promise<SSHCommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}
