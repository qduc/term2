import * as winston from 'winston';
import * as path from 'node:path';
import * as fs from 'node:fs';
import envPaths from 'env-paths';
import DailyRotateFile from 'winston-daily-rotate-file';

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
    private openrouterLogger!: winston.Logger;

    constructor(config: LoggingServiceConfig = {}) {
        const {
            logDir,
            logLevel = 'info',
            disableLogging,
            console: enableConsole = false,
            debugLogging = false,
            suppressConsoleOutput = true,
        } = config;

        const resolvedDisableLogging =
            disableLogging ??
            (parseBooleanEnv(process.env.DISABLE_LOGGING) ||
                Boolean(process.env.AVA));

        this.debugLogging = debugLogging;
        this.suppressConsoleOutput = suppressConsoleOutput;

        // Determine log directory
        const finalLogDir = logDir || path.join(envPaths('term2').log, 'logs');

        // Create log directory if needed and logging is enabled
        if (!resolvedDisableLogging) {
            try {
                if (!fs.existsSync(finalLogDir)) {
                    fs.mkdirSync(finalLogDir, {recursive: true});
                }
            } catch (error: any) {
                // Graceful degradation: log creation errors to stderr only
                this.emitConsoleError(
                    `[LoggingService] Failed to create log directory: ${error.message}`,
                );
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
                    this.emitConsoleError(
                        `[LoggingService] File transport error: ${error.message}`,
                    );
                });

                transports.push(fileTransport);
            } catch (error: any) {
                this.emitConsoleError(
                    `[LoggingService] Failed to configure file transport: ${error.message}`,
                );
            }
        }

        // Optional console transport for development
        if (enableConsole) {
            transports.push(
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple(),
                    ),
                    level: logLevel,
                }),
            );
        }

        // Create logger with custom levels
        this.logger = winston.createLogger({
            levels: LOG_LEVELS,
            format: winston.format.combine(
                winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
                winston.format.json(),
            ),
            defaultMeta: {},
            transports:
                transports.length > 0
                    ? transports
                    : [new winston.transports.Console({silent: true})], // Fallback silent console
        });

        // Add custom log levels to logger if they don't exist
        Object.keys(LOG_LEVELS).forEach(level => {
            if (typeof (this.logger as any)[level] !== 'function') {
                (this.logger as any)[level] = (message: string, meta?: any) => {
                    this.logger.log(level, message, meta);
                };
            }
        });

        // Create openrouter logger
        if (!resolvedDisableLogging) {
            try {
                const openrouterTransport = new DailyRotateFile({
                    dirname: finalLogDir,
                    filename: 'term2-openrouter-%DATE%.log',
                    datePattern: 'YYYY-MM-DD',
                    maxSize: '10m',
                    maxFiles: '14d',
                    format: winston.format.json(),
                    level: logLevel,
                });
                openrouterTransport.on('error', (error: any) => {
                    this.emitConsoleError(
                        `[LoggingService] OpenRouter file transport error: ${error.message}`,
                    );
                });
                this.openrouterLogger = winston.createLogger({
                    levels: LOG_LEVELS,
                    format: winston.format.combine(
                        winston.format.timestamp({
                            format: 'YYYY-MM-DD HH:mm:ss',
                        }),
                        winston.format.json(),
                    ),
                    defaultMeta: {},
                    transports: [openrouterTransport],
                });
                // Add custom log levels
                Object.keys(LOG_LEVELS).forEach(level => {
                    if (
                        typeof (this.openrouterLogger as any)[level] !==
                        'function'
                    ) {
                        (this.openrouterLogger as any)[level] = (
                            message: string,
                            meta?: any,
                        ) => {
                            this.openrouterLogger.log(level, message, meta);
                        };
                    }
                });
            } catch (error: any) {
                if (this.debugLogging) {
                    this.emitConsoleError(
                        `[LoggingService] Failed to configure openrouter transport: ${error.message}`,
                    );
                }
                // Fallback
                this.openrouterLogger = winston.createLogger({
                    levels: LOG_LEVELS,
                    transports: [
                        new winston.transports.Console({silent: true}),
                    ],
                });
            }
        } else {
            this.openrouterLogger = winston.createLogger({
                levels: LOG_LEVELS,
                transports: [new winston.transports.Console({silent: true})],
            });
        }
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
            this.emitConsoleError(
                `[LoggingService] Invalid log level: ${level}`,
            );
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

            // Update openrouter logger transports
            this.openrouterLogger.transports.forEach((t: any) => {
                try {
                    t.level = level;
                } catch (err: any) {
                    // ignore
                }
            });
        } catch (error: any) {
            this.emitConsoleError(
                `[LoggingService] Failed to set log level: ${
                    (error as Error).message
                }`,
            );
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

    logToOpenrouter(
        level: string,
        message: string,
        meta?: Record<string, any>,
    ): void {
        try {
            const metadata = {
                ...meta,
                ...(this.correlationId && {correlationId: this.correlationId}),
            };
            this.openrouterLogger.log(level, message, metadata);
        } catch (error: any) {
            this.emitConsoleError(
                `[LoggingService] Error logging to openrouter: ${error.message}`,
            );
        }
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

    private log(
        level: string,
        message: string,
        meta?: Record<string, any>,
    ): void {
        try {
            const metadata = {
                ...meta,
                ...(this.correlationId && {correlationId: this.correlationId}),
            };

            if (
                this.logger &&
                typeof (this.logger as any)[level] === 'function'
            ) {
                (this.logger as any)[level](message, metadata);
            } else if (this.logger) {
                this.logger.log(level, message, metadata);
            }
        } catch (error: any) {
            // Gracefully handle logging errors
            this.emitConsoleError(
                `[LoggingService] Error logging message: ${error.message}`,
            );
        }
    }

    #log(level: string, message: string, meta?: Record<string, any>): void {
        this.log(level, message, meta);
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
    disableLogging:
        parseBooleanEnv(process.env.DISABLE_LOGGING) ||
        Boolean(process.env.AVA),
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
