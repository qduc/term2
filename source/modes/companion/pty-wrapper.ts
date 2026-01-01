import * as pty from 'node-pty';
import {EventEmitter} from 'events';
import type {ILoggingService} from '../../services/service-interfaces.js';

export interface PTYWrapperOptions {
    logger: ILoggingService;
    shell?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

export interface PTYWrapperEvents {
    output: (data: string) => void;
    exit: (exitCode: number, signal?: number) => void;
    error: (error: Error) => void;
}

const MAX_RESTART_ATTEMPTS = 3;

/**
 * PTY Wrapper for companion mode.
 * Spawns user's shell in a PTY, intercepting I/O for context building.
 */
export class PTYWrapper extends EventEmitter {
    #pty: pty.IPty | null = null;
    #logger: ILoggingService;
    #shell: string;
    #cwd: string;
    #env: NodeJS.ProcessEnv;
    #restartAttempts = 0;
    #isStarted = false;

    constructor(options: PTYWrapperOptions) {
        super();
        this.#logger = options.logger;
        this.#shell = options.shell || process.env.SHELL || '/bin/bash';
        this.#cwd = options.cwd || process.cwd();
        this.#env = options.env || process.env;
    }

    /**
     * Start the PTY with the user's shell.
     */
    start(): void {
        if (this.#isStarted) {
            this.#logger.warn('PTY already started');
            return;
        }

        try {
            const cols = process.stdout.columns || 80;
            const rows = process.stdout.rows || 24;

            this.#pty = pty.spawn(this.#shell, [], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: this.#cwd,
                env: this.#env as {[key: string]: string},
            });

            this.#isStarted = true;
            this.#restartAttempts = 0;

            this.#logger.info('PTY started', {
                shell: this.#shell,
                cwd: this.#cwd,
                cols,
                rows,
                pid: this.#pty.pid,
            });

            // Handle output from PTY
            this.#pty.onData((data: string) => {
                this.emit('output', data);
            });

            // Handle PTY exit
            this.#pty.onExit(({exitCode, signal}) => {
                this.#isStarted = false;
                this.#logger.info('PTY exited', {exitCode, signal});
                this.emit('exit', exitCode, signal);

                // Attempt restart if unexpected exit
                if (exitCode !== 0) {
                    this.#handleUnexpectedExit(exitCode, signal);
                }
            });
        } catch (error: unknown) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.#logger.error('Failed to spawn PTY', {
                error: errorMessage,
                shell: this.#shell,
            });
            this.emit('error', new Error(`Could not start shell: ${this.#shell}`));
        }
    }

    /**
     * Write data to the PTY.
     */
    write(data: string): void {
        if (!this.#pty) {
            this.#logger.warn('Cannot write to PTY: not started');
            return;
        }
        this.#pty.write(data);
    }

    /**
     * Resize the PTY.
     */
    resize(cols: number, rows: number): void {
        if (!this.#pty) {
            return;
        }
        this.#pty.resize(cols, rows);
        this.#logger.debug('PTY resized', {cols, rows});
    }

    /**
     * Stop the PTY.
     */
    stop(): void {
        if (!this.#pty) {
            return;
        }
        this.#pty.kill();
        this.#pty = null;
        this.#isStarted = false;
        this.#logger.info('PTY stopped');
    }

    /**
     * Check if PTY is running.
     */
    get isRunning(): boolean {
        return this.#isStarted && this.#pty !== null;
    }

    /**
     * Get the PTY process ID.
     */
    get pid(): number | undefined {
        return this.#pty?.pid;
    }

    /**
     * Handle unexpected PTY exit with restart logic.
     */
    #handleUnexpectedExit(exitCode: number, signal?: number): void {
        if (this.#restartAttempts >= MAX_RESTART_ATTEMPTS) {
            this.#logger.error('PTY crashed repeatedly, giving up', {
                attempts: this.#restartAttempts,
            });
            this.emit('error', new Error('Shell crashed repeatedly'));
            return;
        }

        this.#restartAttempts++;
        this.#logger.warn('PTY exited unexpectedly, attempting restart', {
            exitCode,
            signal,
            attempt: this.#restartAttempts,
        });

        // Wait a bit before restarting
        setTimeout(() => {
            this.start();
        }, 500);
    }
}
