import * as winston from 'winston';
import * as path from 'node:path';
import * as fs from 'node:fs';
import envPaths from 'env-paths';

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

	constructor(config: LoggingServiceConfig = {}) {
		const {
			logDir,
			logLevel = process.env.LOG_LEVEL || 'info',
			disableLogging = process.env.DISABLE_LOGGING === 'true',
			console: enableConsole = process.env.DEBUG_LOGGING !== undefined,
		} = config;

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
				if (process.env.DEBUG_LOGGING) {
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
				// Check if we should use daily rotation (default) or simple file (testing)
				const useSimpleFile = process.env.NODE_ENV === 'test';

				if (useSimpleFile) {
					// Simple file transport for testing
					transports.push(
						new winston.transports.File({
							dirname: finalLogDir,
							filename: 'term2.log',
							format: winston.format.json(),
							level: logLevel,
						}),
					);
				} else {
					// File transport with daily rotation
					const DailyRotateFile = require('winston-daily-rotate-file');
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
						if (process.env.DEBUG_LOGGING) {
							console.error(
								`[LoggingService] File transport error: ${error.message}`,
							);
						}
					});

					transports.push(fileTransport);
				}
			} catch (error: any) {
				if (process.env.DEBUG_LOGGING) {
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

		// Add custom log levels to logger
		Object.entries(LOG_LEVELS).forEach(([level]) => {
			if (!(level in this.logger)) {
				(this.logger as any).log(level, '', {level});
			}
		});
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

	private log(level: string, message: string, meta?: Record<string, any>): void {
		try {
			const metadata = {
				...meta,
				...(this.correlationId && {correlationId: this.correlationId}),
			};

			(this.logger as any)[level](message, metadata);
		} catch (error: any) {
			// Gracefully handle logging errors
			if (process.env.DEBUG_LOGGING) {
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

/**
 * Singleton export for convenience
 */
export const loggingService = new LoggingService();
