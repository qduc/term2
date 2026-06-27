export type SessionTrafficContext = {
  sessionId: string;
  sessionStartedAt: string;
  mode?: string;
  traceId?: string;
  evaluator?: boolean;
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

export interface IProviderTraffic {
  recordRequestStart(input: ProviderTrafficRequest): void;
  recordResponseReceived(input: ProviderTrafficResponse): Promise<void>;
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
  get<T = any>(key: string): T;
  set(key: string, value: any, options?: { persist?: boolean }): void;
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
