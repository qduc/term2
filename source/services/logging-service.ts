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

interface LoggingServiceConfig {
    logDir?: string;
    logLevel?: string;
    disableLogging?: boolean;
    console?: boolean;
    debugLogging?: boolean;
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
	private openrouterLogger!: winston.Logger;

	constructor(config: LoggingServiceConfig = {}) {
		const {
			logDir,
			logLevel = 'info',
			disableLogging = false,
			console: enableConsole = false,
			debugLogging = false,
		} = config;

		this.debugLogging = debugLogging;

		// Determine log directory
		const finalLogDir = logDir || path.join(envPaths('term2').log, 'logs');

		// Create log directory if needed and logging is enabled
		if (!disableLogging) {
			try {
				if (!fs.existsSync(finalLogDir)) {
					fs.mkdirSync(finalLogDir, {recursive: true});
				}
			} catch (error: any) {
				// Graceful degradation: log creation errors to stderr only
				if (this.debugLogging) {
					console.error(
						`[LoggingService] Failed to create log directory: ${error.message}`,
					);
				}
			}
		}

		// Configure Winston logger
		const transports: winston.transport[] = [];

		if (!disableLogging) {
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
					if (this.debugLogging) {
						console.error(
							`[LoggingService] File transport error: ${error.message}`,
						);
					}
				});

				transports.push(fileTransport);
			} catch (error: any) {
				if (this.debugLogging) {
					console.error(
						`[LoggingService] Failed to configure file transport: ${error.message}`,
					);
				}
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
		if (!disableLogging) {
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
					if (this.debugLogging) {
						console.error(
							`[LoggingService] OpenRouter file transport error: ${error.message}`,
						);
					}
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
					console.error(
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

	/**
	 * Set the current log level at runtime; updates logger and all transports
	 */
	setLogLevel(level: string): void {
		if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
			// If invalid, ignore
			if (this.debugLogging) {
				console.error(`[LoggingService] Invalid log level: ${level}`);
			}
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
			if (this.debugLogging) {
				console.error(
					`[LoggingService] Failed to set log level: ${
						(error as Error).message
					}`,
				);
			}
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
			if (this.debugLogging) {
				console.error(
					`[LoggingService] Error logging to openrouter: ${error.message}`,
				);
			}
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
			if (this.debugLogging) {
				console.error(
					`[LoggingService] Error logging message: ${error.message}`,
				);
			}
		}
	}

	#log(level: string, message: string, meta?: Record<string, any>): void {
		this.log(level, message, meta);
	}
}

const parseBooleanEnv = (value: unknown): boolean => {
    if (typeof value !== 'string') {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

/**
 * Singleton export for convenience
 */
export const loggingService = new LoggingService({
    disableLogging: parseBooleanEnv(process.env.DISABLE_LOGGING) || Boolean(process.env.AVA),
    debugLogging: parseBooleanEnv(process.env.DEBUG_LOGGING),
});
