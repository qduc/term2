import type { SettingKey, SettingValue } from './settings/settings-schema.js';

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
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
  security(message: string, meta?: any): void;
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
