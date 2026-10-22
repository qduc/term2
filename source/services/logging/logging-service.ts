import * as winston from 'winston';
import * as path from 'node:path';
import * as fs from 'node:fs';
import envPaths from 'env-paths';
import DailyRotateFile from 'winston-daily-rotate-file';
import {
  RuntimeLogSchema,
  buildRuntimeLogRecord,
  parseCategoryFilter,
  resolveLogCategory,
  shouldIncludeVerbosePayload,
  shouldLogForCategory,
  shouldSampleLog,
  type LogCategory,
} from './logging-contract.js';
import { truncateLogText, sanitizeLogMetadata } from '../../utils/output/log-truncation.js';
import { ProviderTraffic, ProviderTrafficArtifactStore } from './provider-traffic.js';
import type { ISessionContextService, LogMetadataContract } from '../service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../session/session-context-service.js';

const LOG_RETENTION_DAYS = 7;
const LOG_DIRECTORY_MAX_BYTES = 512 * 1024 * 1024;

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
  rawTrafficCaptureEnabled?: boolean;
  console?: boolean;
  debugLogging?: boolean;
  suppressConsoleOutput?: boolean;
  sessionContextService?: ISessionContextService;
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
  private fileLoggingDisabled = false;
  private trafficCleanupFailureReported = false;
  private correlationId: string | undefined;
  private debugLogging: boolean;
  private suppressConsoleOutput: boolean;
  private providerTrafficDir: string;
  private evaluatorTrafficDir: string;
  private enabledCategories: Set<LogCategory> | null;
  private verbosePayloads: boolean;
  private sampleRate: number;
  private providerTrafficStore: ProviderTrafficArtifactStore;
  readonly providerTraffic: ProviderTraffic;

  constructor(config: LoggingServiceConfig = {}) {
    const {
      logDir,
      logLevel = process.env.LOG_LEVEL || 'info',
      disableLogging,
      rawTrafficCaptureEnabled,
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
    const mainLogAuditFile = path.join(finalLogDir, 'term2-audit.json');
    this.providerTrafficDir = path.join(finalLogDir, 'provider-traffic');
    this.evaluatorTrafficDir = path.join(finalLogDir, 'evaluator-traffic');
    this.providerTrafficStore = new ProviderTrafficArtifactStore({
      rootDir: this.providerTrafficDir,
      rawCaptureEnabled: rawTrafficCaptureEnabled,
      enabled: !resolvedDisableLogging,
    });
    this.providerTraffic = new ProviderTraffic(
      this,
      config.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
      this.providerTrafficStore,
    );

    // Create log directory if needed and logging is enabled
    if (!resolvedDisableLogging) {
      try {
        if (!fs.existsSync(finalLogDir)) {
          fs.mkdirSync(finalLogDir, { recursive: true });
        }
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
          maxFiles: `${LOG_RETENTION_DAYS}d`,
          auditFile: mainLogAuditFile,
          format: winston.format.json(),
          level: logLevel,
        });

        // file-stream-rotator emits write failures on the transport's inner
        // stream, not just on the Winston transport. Listen at both boundaries
        // and disable the failed sink once; otherwise later writes can emit
        // another unhandled error from the same broken stream.
        const handleFileError = (error: Error): void => this.disableFileLogging(fileTransport, error);
        fileTransport.logStream.on('error', handleFileError);
        fileTransport.on('error', handleFileError);

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
        (this.logger as any)[level] = (message: string, meta?: LogMetadataContract) => {
          this.logger.log(level, message, meta);
        };
      }
    });

    // Retention is deliberately a startup sweep, not request-path work. The
    // daily file transport also enforces maxSize/maxFiles for application logs.
    if (!resolvedDisableLogging) {
      this.cleanupProviderTraffic();
    }
  }

  /**
   * Return the current effective log level for the logger
   */
  getLogLevel(): string {
    try {
      return (this.logger as any).level || 'info';
    } catch (_error: any) {
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
        } catch (_err: any) {
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
  error(message: string, meta?: LogMetadataContract): void {
    this.#log('error', message, meta);
  }

  /**
   * Log warn-level message
   */
  warn(message: string, meta?: LogMetadataContract): void {
    this.#log('warn', message, meta);
  }

  /**
   * Log info-level message
   */
  info(message: string, meta?: LogMetadataContract): void {
    this.#log('info', message, meta);
  }

  /**
   * Log security event (custom level)
   */
  security(message: string, meta?: LogMetadataContract): void {
    this.#log('security', message, meta);
  }

  /**
   * Log debug-level message
   */
  debug(message: string, meta?: LogMetadataContract): void {
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
   * Remove old and over-budget provider/evaluator traffic logs at startup.
   */
  private cleanupProviderTraffic(maxDays = LOG_RETENTION_DAYS, maxBytes = LOG_DIRECTORY_MAX_BYTES): void {
    this.cleanupRotatedApplicationLogs(path.dirname(this.providerTrafficDir), maxDays, maxBytes);
    this.cleanupTrafficDir(this.providerTrafficDir, maxDays, maxBytes);
    this.cleanupTrafficDir(this.evaluatorTrafficDir, maxDays, maxBytes);
  }

  private cleanupRotatedApplicationLogs(dir: string, maxDays: number, maxBytes: number): void {
    try {
      if (!fs.existsSync(dir)) return;
      const threshold = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const groups = new Map<string, Array<{ filePath: string; bytes: number }>>();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = /^term2-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?$/.exec(entry.name);
        if (!match) continue;
        const filePath = path.join(dir, entry.name);
        const files = groups.get(match[1]!) ?? [];
        files.push({ filePath, bytes: fs.statSync(filePath).size });
        groups.set(match[1]!, files);
      }

      for (const [dateKey, files] of groups) {
        if (dateKey < threshold)
          groups.set(
            dateKey,
            files.filter(({ filePath }) => !this.removeLogFile(filePath)),
          );
      }

      const orderedDays = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
      let totalBytes = [...groups.values()].flat().reduce((total, file) => total + file.bytes, 0);
      for (const [, files] of orderedDays) {
        if (totalBytes <= maxBytes) break;
        for (const file of files) {
          if (this.removeLogFile(file.filePath)) totalBytes -= file.bytes;
        }
      }
    } catch (error) {
      this.reportTrafficCleanupFailure(error);
    }
  }

  private removeLogFile(filePath: string): boolean {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch (error) {
      this.reportTrafficCleanupFailure(error);
      return false;
    }
  }

  private cleanupTrafficDir(dir: string, maxDays: number, maxBytes: number): void {
    try {
      if (!fs.existsSync(dir)) {
        return;
      }

      const now = new Date();
      const threshold = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
      const thresholdStr = threshold.toISOString().slice(0, 10); // YYYY-MM-DD

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const datedEntries: Array<{ name: string; fullPath: string; dateKey: string; bytes: number }> = [];
      for (const entry of entries) {
        let dateKey: string | undefined;
        const fullPath = path.join(dir, entry.name);

        if (entry.isFile()) {
          const match = entry.name.match(/^traffic-(\d{4}-\d{2}-\d{2})\.log$/);
          if (match) {
            dateKey = match[1];
          }
        } else if (entry.isDirectory()) {
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (match) {
            dateKey = match[1];
          }
        }

        if (!dateKey) continue;
        if (dateKey < thresholdStr) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (error) {
            this.reportTrafficCleanupFailure(error);
            datedEntries.push({ name: entry.name, fullPath, dateKey, bytes: this.measureTrafficBytes(fullPath) });
          }
          continue;
        }

        datedEntries.push({ name: entry.name, fullPath, dateKey, bytes: this.measureTrafficBytes(fullPath) });
      }

      let totalBytes = datedEntries.reduce((total, entry) => total + entry.bytes, 0);
      for (const entry of datedEntries.sort((a, b) => a.dateKey.localeCompare(b.dateKey))) {
        if (totalBytes <= maxBytes) break;
        try {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
          totalBytes -= entry.bytes;
        } catch (error) {
          this.reportTrafficCleanupFailure(error);
        }
      }
    } catch (error: any) {
      this.reportTrafficCleanupFailure(error);
    }
  }

  private measureTrafficBytes(filePath: string): number {
    const stat = fs.lstatSync(filePath);
    if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
    return fs
      .readdirSync(filePath)
      .reduce((total, name) => total + this.measureTrafficBytes(path.join(filePath, name)), 0);
  }

  private reportTrafficCleanupFailure(error: unknown): void {
    if (this.trafficCleanupFailureReported) return;
    this.trafficCleanupFailureReported = true;
    const message = error instanceof Error ? error.message : String(error);
    this.warn('Provider traffic retention cleanup failed', {
      eventType: 'logging.retention_cleanup_failed',
      category: 'logging',
      errorMessage: message,
    });
  }

  private log(level: string, message: string, meta?: LogMetadataContract): void {
    try {
      // Callers that own an asynchronous operation can provide its correlation
      // explicitly. That must beat the mutable process-wide fallback, otherwise
      // overlapping background work is misattributed to the foreground turn.
      const correlationId = typeof meta?.correlationId === 'string' ? meta.correlationId : this.correlationId;
      let metadata = {
        ...(this.correlationId && { correlationId: this.correlationId }),
        ...(meta ?? {}),
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
        correlationId,
        meta: metadata,
      });

      // Strip internal wiring fields that leak into runtime logs
      delete runtimeRecord.modelClass;
      delete runtimeRecord.modelWrapperClass;
      if ('attempt' in runtimeRecord && 'retryAttempt' in runtimeRecord) {
        delete runtimeRecord.attempt;
      }
      if ('rawEvent' in runtimeRecord) {
        delete runtimeRecord.rawEvent;
      }

      // category no longer appears in the record; derive it from eventType for filtering
      const eventType = typeof runtimeRecord.eventType === 'string' ? runtimeRecord.eventType : '';
      const category = resolveLogCategory({ eventType });
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

  #log(level: string, message: string, meta?: LogMetadataContract): void {
    this.log(level, message, meta);
  }

  private emitConsoleError(message: string): void {
    if (!this.debugLogging || this.suppressConsoleOutput) {
      return;
    }
    console.error(message);
  }

  private disableFileLogging(transport: DailyRotateFile, error: Error): void {
    if (this.fileLoggingDisabled) return;
    this.fileLoggingDisabled = true;

    if (this.logger) {
      this.logger.remove(transport);
    }
    try {
      transport.close?.();
    } catch {
      // The sink has already failed; shutdown is best effort.
    }

    // Disk errors must be visible even when routine console logging is
    // suppressed. Never route this warning back through the failed logger.
    try {
      process.stderr.write(`[LoggingService] File logging disabled after write failure: ${error.message}\n`);
    } catch {
      // A broken stderr must not turn a diagnostic failure into an app crash.
    }
  }
}
