import * as pty from 'node-pty';
import type {IPty} from 'node-pty';
import type {ILoggingService} from '../../services/service-interfaces.js';

/**
 * PTY wrapper for spawning and managing a user shell.
 * Provides passthrough I/O with the ability to intercept and inject commands.
 *
 * Phase 1: Basic passthrough functionality
 * Future: Command capture, injection for auto mode
 */

type PtyFactory = (
	shell: string,
	args: string[],
	options: pty.IPtyForkOptions,
) => IPty;

export interface PTYWrapperOptions {
	ptyFactory?: PtyFactory;
	shell?: string;
	logger?: ILoggingService;
}

export class PTYWrapper {
	#pty: IPty | null = null;
	#ptyFactory: PtyFactory;
	#shell: string;
	#logger?: ILoggingService;
	#outputHandlers: Array<(data: string) => void> = [];

	constructor(options: PTYWrapperOptions = {}) {
		this.#ptyFactory = options.ptyFactory || pty.spawn;
		this.#shell = options.shell || process.env.SHELL || '/bin/bash';
		this.#logger = options.logger;
	}

	/**
	 * Start the PTY with the user's shell.
	 * Returns the PTY instance for advanced use cases.
	 */
	start(): IPty {
		if (this.#pty) {
			throw new Error('PTY already started');
		}

		this.#logger?.debug('Starting PTY', {shell: this.#shell});

		try {
			this.#pty = this.#ptyFactory(this.#shell, [], {
				name: 'xterm-256color',
				cols: process.stdout.columns || 80,
				rows: process.stdout.rows || 24,
				cwd: process.cwd(),
				env: process.env as Record<string, string>,
			});

			// Forward PTY output to stdout (passthrough)
			this.#pty.onData(data => {
				process.stdout.write(data);
				// Notify handlers
				this.#outputHandlers.forEach(handler => handler(data));
			});

			// Forward stdin to PTY
			process.stdin.on('data', data => {
				if (this.#pty) {
					this.#pty.write(data.toString());
				}
			});

			// Handle PTY exit
			this.#pty.onExit(({exitCode, signal}) => {
				this.#logger?.info('PTY exited', {exitCode, signal});
			});

			// Handle terminal resize
			process.stdout.on('resize', () => {
				if (this.#pty) {
					this.resize(process.stdout.columns, process.stdout.rows);
				}
			});

			this.#logger?.info('PTY started successfully');

			return this.#pty;
		} catch (error) {
			this.#logger?.error('Failed to start PTY', {error});
			throw error;
		}
	}

	/**
	 * Stop the PTY.
	 */
	stop(): void {
		if (this.#pty) {
			this.#pty.kill();
			this.#pty = null;
		}
	}

	/**
	 * Write data to the PTY (inject commands).
	 */
	write(data: string): void {
		if (!this.#pty) {
			throw new Error('PTY not started');
		}
		this.#pty.write(data);
	}

	/**
	 * Resize the PTY.
	 */
	resize(cols: number, rows: number): void {
		if (!this.#pty) {
			throw new Error('PTY not started');
		}
		this.#pty.resize(cols, rows);
	}

	/**
	 * Register a handler for PTY output.
	 * Handlers are called after output is written to stdout.
	 */
	onOutput(handler: (data: string) => void): void {
		this.#outputHandlers.push(handler);
	}
}
