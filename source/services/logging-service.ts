import * as winston from 'winston';
import * as path from 'node:path';
import * as fs from 'node:fs';
import envPaths from 'env-paths';
import DailyRotateFile from 'winston-daily-rotate-file';
import {
  RuntimeLogSchema,
  buildRuntimeLogRecord,
  parseCategoryFilter,
  shouldIncludeVerbosePayload,
  shouldLogForCategory,
  shouldSampleLog,
  type LogCategory,
} from './logging-contract.js';
import { truncateLogText, sanitizeLogMetadata } from '../utils/log-truncation.js';
import { ProviderTrafficArtifactStore } from './provider-traffic.js';

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  security: 3,
  debug: 4,
};

const parseBooleanEnv = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

interface LoggingServiceConfig {
  logDir?: string;
  logLevel?: string;
  disableLogging?: boolean;
  console?: boolean;
  debugLogging?: boolean;
  suppressConsoleOutput?: boolean;
}

/**
 * Winston-based logging service for development, debugging, and security auditing.
 *
 * Features:
 * - Custom log levels (error, warn, security, info, debug)
 * - JSON-formatted file output with daily rotation
 * - XDG-compliant log directories
 * - Correlation ID tracking for request flows
 * - Graceful degradation on write failures
 * - Optional console output for development
 */
export class LoggingService {
  private logger: winston.Logger;
  private correlationId: string | undefined;
  private debugLogging: boolean;
  private suppressConsoleOutput: boolean;
  private providerTrafficDir: string;
  private evaluatorTrafficDir: string;
  private enabledCategories: Set<LogCategory> | null;
  private verbosePayloads: boolean;
  private sampleRate: number;
  private providerTrafficStore: ProviderTrafficArtifactStore;

  constructor(config: LoggingServiceConfig = {}) {
    const {
      logDir,
      logLevel = process.env.LOG_LEVEL || 'info',
      disableLogging,
      console: enableConsole = false,
      debugLogging = false,
      suppressConsoleOutput = true,
    } = config;

    const resolvedDisableLogging =
      disableLogging ?? (parseBooleanEnv(process.env.DISABLE_LOGGING) || Boolean(process.env.AVA));

    this.debugLogging = debugLogging;
    this.suppressConsoleOutput = suppressConsoleOutput;
    this.enabledCategories = parseCategoryFilter(process.env.LOG_CATEGORIES);
    this.verbosePayloads = parseBooleanEnv(process.env.LOG_VERBOSE_PAYLOADS);
    this.sampleRate = Number.parseFloat(process.env.LOG_SAMPLE_RATE ?? '1');
    if (!Number.isFinite(this.sampleRate)) {
      this.sampleRate = 1;
    }

    // Determine log directory
    const finalLogDir = logDir || path.join(envPaths('term2').log, 'logs');
    this.providerTrafficDir = path.join(finalLogDir, 'provider-traffic');
    this.evaluatorTrafficDir = path.join(finalLogDir, 'evaluator-traffic');
    this.providerTrafficStore = new ProviderTrafficArtifactStore({ rootDir: this.providerTrafficDir });

    // Create log directory if needed and logging is enabled
    if (!resolvedDisableLogging) {
      try {
        if (!fs.existsSync(finalLogDir)) {
          fs.mkdirSync(finalLogDir, { recursive: true });
        }
        this.cleanupProviderTraffic();
      } catch (error: any) {
        // Graceful degradation: log creation errors to stderr only
        this.emitConsoleError(`[LoggingService] Failed to create log directory: ${error.message}`);
      }
    }

    // Configure Winston logger
    const transports: winston.transport[] = [];

    if (!resolvedDisableLogging) {
      try {
        // File transport with daily rotation
        const fileTransport = new DailyRotateFile({
          dirname: finalLogDir,
          filename: 'term2-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxSize: '10m',
          maxFiles: '14d',
          format: winston.format.json(),
          level: logLevel,
        });

        // Handle transport errors gracefully
        fileTransport.on('error', (error: any) => {
          this.emitConsoleError(`[LoggingService] File transport error: ${error.message}`);
        });

        transports.push(fileTransport);
      } catch (error: any) {
        this.emitConsoleError(`[LoggingService] Failed to configure file transport: ${error.message}`);
      }
    }

    // Optional console transport for development
    if (enableConsole) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
          level: logLevel,
        }),
      );
    }

    // Create logger with custom levels
    this.logger = winston.createLogger({
      levels: LOG_LEVELS,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json(),
      ),
      defaultMeta: {},
      transports: transports.length > 0 ? transports : [new winston.transports.Console({ silent: true })], // Fallback silent console
    });

    // Add custom log levels to logger if they don't exist
    Object.keys(LOG_LEVELS).forEach((level) => {
      if (typeof (this.logger as any)[level] !== 'function') {
        (this.logger as any)[level] = (message: string, meta?: any) => {
          this.logger.log(level, message, meta);
        };
      }
    });
  }

  /**
   * Return the current effective log level for the logger
   */
  getLogLevel(): string {
    try {
      return (this.logger as any).level || 'info';
    } catch (error: any) {
      return 'info';
    }
  }

  setSuppressConsoleOutput(value: boolean): void {
    this.suppressConsoleOutput = value;
  }

  /**
   * Set the current log level at runtime; updates logger and all transports
   */
  setLogLevel(level: string): void {
    if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
      // If invalid, ignore
      this.emitConsoleError(`[LoggingService] Invalid log level: ${level}`);
      return;
    }

    try {
      (this.logger as any).level = level;

      // Update each transport's level as well
      this.logger.transports.forEach((t: any) => {
        try {
          t.level = level;
        } catch (err: any) {
          // ignore
        }
      });
    } catch (error: any) {
      this.emitConsoleError(`[LoggingService] Failed to set log level: ${(error as Error).message}`);
    }
  }

  /**
   * Log error-level message
   */
  error(message: string, meta?: Record<string, any>): void {
    this.#log('error', message, meta);
  }

  /**
   * Log warn-level message
   */
  warn(message: string, meta?: Record<string, any>): void {
    this.#log('warn', message, meta);
  }

  /**
   * Log info-level message
   */
  info(message: string, meta?: Record<string, any>): void {
    this.#log('info', message, meta);
  }

  /**
   * Log security event (custom level)
   */
  security(message: string, meta?: Record<string, any>): void {
    this.#log('security', message, meta);
  }

  /**
   * Log debug-level message
   */
  debug(message: string, meta?: Record<string, any>): void {
    this.#log('debug', message, meta);
  }

  /**
   * Set correlation ID for tracking related operations
   */
  setCorrelationId(id: string): void {
    this.correlationId = id;
  }

  /**
   * Clear correlation ID
   */
  clearCorrelationId(): void {
    this.correlationId = undefined;
  }

  /**
   * Get correlation ID
   */
  getCorrelationId(): string | undefined {
    return this.correlationId;
  }

  /**
   * Remove provider and evaluator traffic logs older than maxFiles (default 30d)
   */
  private cleanupProviderTraffic(maxDays = 30): void {
    this.cleanupTrafficDir(this.providerTrafficDir, maxDays);
    this.cleanupTrafficDir(this.evaluatorTrafficDir, maxDays);
  }

  private cleanupTrafficDir(dir: string, maxDays: number): void {
    try {
      if (!fs.existsSync(dir)) {
        return;
      }

      const now = new Date();
      const threshold = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
      const thresholdStr = threshold.toISOString().slice(0, 10); // YYYY-MM-DD

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        let dateKey: string | undefined;
        let isDir = false;

        if (entry.isFile()) {
          const match = entry.name.match(/^traffic-(\d{4}-\d{2}-\d{2})\.log$/);
          if (match) {
            dateKey = match[1];
          }
        } else if (entry.isDirectory()) {
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (match) {
            dateKey = match[1];
            isDir = true;
          }
        }

        if (dateKey && dateKey < thresholdStr) {
          const fullPath = path.join(dir, entry.name);
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (err: any) {
            this.emitConsoleError(
              `[LoggingService] Failed to delete old traffic ${isDir ? 'directory' : 'log'} ${entry.name}: ${
                err.message
              }`,
            );
          }
        }
      }
    } catch (error: any) {
      this.emitConsoleError(`[LoggingService] Error during provider traffic cleanup: ${error.message}`);
    }
  }

  private log(level: string, message: string, meta?: Record<string, any>): void {
    try {
      let metadata = {
        ...(meta ?? {}),
        ...(this.correlationId && { correlationId: this.correlationId }),
      } as Record<string, unknown>;

      if (metadata.eventType === 'provider.request.started') {
        metadata = sanitizeLogMetadata(metadata);
      }
      if (metadata.eventType === 'provider.response.received') {
        const nextMetadata = { ...metadata } as Record<string, unknown>;
        if (typeof nextMetadata.text === 'string') {
          nextMetadata.text = truncateLogText(nextMetadata.text);
        }
        if (nextMetadata.payload && typeof nextMetadata.payload === 'object' && !Array.isArray(nextMetadata.payload)) {
          const payload = { ...(nextMetadata.payload as Record<string, unknown>) };
          if (typeof payload.raw === 'string') {
            payload.raw = truncateLogText(payload.raw);
          }
          if (typeof payload.rawPreview === 'string') {
            payload.rawPreview = truncateLogText(payload.rawPreview);
          }
          nextMetadata.payload = payload;
        }
        metadata = nextMetadata;
      }

      const runtimeRecord = buildRuntimeLogRecord({
        level,
        correlationId: this.correlationId,
        meta: metadata,
      });

      this.writeProviderTrafficArtifact(runtimeRecord, message);

      const category = (runtimeRecord.category as LogCategory) ?? 'general';
      if (!shouldLogForCategory({ level, category, enabledCategories: this.enabledCategories })) {
        return;
      }

      if (!shouldSampleLog({ level, sampleRate: this.sampleRate, randomValue: Math.random() })) {
        return;
      }

      if (!shouldIncludeVerbosePayload({ level, verbosePayloads: this.verbosePayloads })) {
        delete runtimeRecord.payload;
      }

      const parsed = RuntimeLogSchema.safeParse(runtimeRecord);
      if (!parsed.success) {
        runtimeRecord.eventType = 'log.contract_validation_failed';
        runtimeRecord.errorCode = 'LOG_SCHEMA_VALIDATION_FAILED';
        runtimeRecord.errorMessage = parsed.error.issues.map((issue) => issue.message).join('; ');
      }

      if (this.logger && typeof (this.logger as any)[level] === 'function') {
        (this.logger as any)[level](message, runtimeRecord);
      } else if (this.logger) {
        this.logger.log(level, message, runtimeRecord);
      }
    } catch (error: any) {
      // Gracefully handle logging errors
      this.emitConsoleError(`[LoggingService] Error logging message: ${error.message}`);
    }
  }

  #log(level: string, message: string, meta?: Record<string, any>): void {
    this.log(level, message, meta);
  }

  private writeProviderTrafficArtifact(runtimeRecord: Record<string, unknown>, _message: string): void {
    const eventType = typeof runtimeRecord.eventType === 'string' ? runtimeRecord.eventType : '';
    const requestId = typeof runtimeRecord.requestId === 'string' ? runtimeRecord.requestId : undefined;
    const sessionId = typeof runtimeRecord.sessionId === 'string' ? runtimeRecord.sessionId : undefined;
    const sessionStartedAt =
      typeof runtimeRecord.sessionStartedAt === 'string' ? runtimeRecord.sessionStartedAt : undefined;
    if (!requestId || !sessionId || !sessionStartedAt) {
      return;
    }

    const timestamp =
      typeof runtimeRecord.timestamp === 'string' && runtimeRecord.timestamp
        ? runtimeRecord.timestamp
        : new Date().toISOString();
    const provider = typeof runtimeRecord.provider === 'string' ? runtimeRecord.provider : 'unknown';
    const model = typeof runtimeRecord.model === 'string' ? runtimeRecord.model : 'unknown';
    const mode = typeof runtimeRecord.mode === 'string' ? runtimeRecord.mode : 'unknown';
    const firstUserMessagePreview =
      typeof runtimeRecord.firstUserMessagePreview === 'string' ? runtimeRecord.firstUserMessagePreview : undefined;

    try {
      if (eventType === 'provider.request.started' || eventType === 'evaluator.request.started') {
        const payload = runtimeRecord.payload;
        const headers = runtimeRecord.headers;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          this.providerTrafficStore.recordRequestStart({
            requestId,
            timestamp,
            provider,
            model,
            sessionId,
            sessionStartedAt,
            mode,
            firstUserMessagePreview,
            sentBody: payload as Record<string, unknown>,
            headers:
              headers && typeof headers === 'object' && !Array.isArray(headers)
                ? (headers as Record<string, string>)
                : undefined,
            evaluator: eventType === 'evaluator.request.started',
          });
        }
        return;
      }

      if (eventType === 'provider.response.received' || eventType === 'evaluator.response.received') {
        const summary = runtimeRecord.payload;
        this.providerTrafficStore.recordRequestComplete({
          requestId,
          timestamp,
          provider,
          model,
          sessionId,
          sessionStartedAt,
          mode,
          receivedSummary: summary && typeof summary === 'object' && !Array.isArray(summary) ? (summary as any) : {},
          evaluator: eventType === 'evaluator.response.received',
        });
        return;
      }

      if (eventType === 'provider.response.failed' || eventType === 'provider.response.log_failed') {
        this.providerTrafficStore.recordRequestComplete({
          requestId,
          timestamp,
          provider,
          model,
          sessionId,
          sessionStartedAt,
          mode,
          error: {
            message:
              typeof runtimeRecord.error === 'string'
                ? runtimeRecord.error
                : typeof runtimeRecord.errorMessage === 'string'
                ? runtimeRecord.errorMessage
                : 'unknown_error',
          },
        });
      }
    } catch (error: any) {
      this.emitConsoleError(`[LoggingService] Failed to write provider traffic artifact: ${error.message}`);
    }
  }

  private emitConsoleError(message: string): void {
    if (!this.debugLogging || this.suppressConsoleOutput) {
      return;
    }
    console.error(message);
  }
}

const isTestEnvironment = () => {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST !== undefined ||
    process.env.AVA_PATH !== undefined ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.TERM2_TEST_MODE === 'true' ||
    Boolean(process.env.AVA)
  );
};

/**
 * @deprecated DO NOT USE - Singleton pattern is deprecated
 *
 * This singleton is deprecated and should not be used in application code.
 * Instead, pass the LoggingService instance via dependency injection:
 *
 * - In services/tools: Accept via constructor deps parameter
 * - In components: Accept as prop or use a context provider
 *
 * This export now throws an error when accessed to catch deprecated usage.
 * It's only allowed in test files for backwards compatibility.
 */
const _loggingServiceInstance = new LoggingService({
  disableLogging: parseBooleanEnv(process.env.DISABLE_LOGGING) || Boolean(process.env.AVA),
  debugLogging: parseBooleanEnv(process.env.DEBUG_LOGGING),
});

export const loggingService = new Proxy(_loggingServiceInstance, {
  get(target, prop) {
    // Allow access in test environment for backwards compatibility
    if (isTestEnvironment()) {
      const value = target[prop as keyof typeof target];
      // Bind methods to the original target to preserve 'this' context
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    }

    // Get the caller's stack trace to show where the deprecated usage is
    const stack = new Error().stack || '';
    const callerLine = stack.split('\n')[2] || 'unknown location';

    throw new Error(
      `DEPRECATED: Direct use of loggingService singleton is not allowed.\n` +
        `Called from: ${callerLine.trim()}\n\n` +
        `Instead, pass LoggingService via dependency injection:\n` +
        `  - In services/tools: Accept via 'deps' constructor parameter\n` +
        `  - In components: Accept as prop or use a context provider\n\n` +
        `The singleton pattern prevents proper testing and makes dependencies unclear.`,
    );
  },
});
