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
  outcome: 'consumer_closed' | 'aborted';
  eventCount: number;
  modelClass?: string;
  modelWrapperClass?: string;
  /**
   * A stream that ends without a terminal event leaves no payload to
   * summarize, so the retained transcript and its timings are the only record
   * of what the model was doing when it was cut off.
   */
  diagnostics?: ProviderTrafficStreamDiagnostics;
}

export interface ProviderTrafficStreamDiagnostics {
  durationMs: number;
  firstEventMs?: number;
  lastEventMs?: number;
  maxGapMs?: number;
  responseId?: string;
  eventTypeCounts: Record<string, number>;
  events: unknown[];
}

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

export interface ISSHService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  executeCommand(
    cmd: string,
    opts?: { cwd?: string },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}
