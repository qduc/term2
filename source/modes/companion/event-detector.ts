import {EventEmitter} from 'events';
import type {CommandEntry} from './context-buffer.js';

export type EventPattern = 'error_cascade' | 'retry_loop' | 'long_pause';

export interface EventDetectorOptions {
    errorCascadeThreshold: number; // Consecutive failures before triggering
    retryLoopThreshold: number; // Repeated commands before triggering
    pauseHintDelayMs: number; // Inactivity after error before triggering
}

export interface DetectedEvent {
    pattern: EventPattern;
    message: string;
    timestamp: number;
}

const DEFAULT_OPTIONS: EventDetectorOptions = {
    errorCascadeThreshold: 3,
    retryLoopThreshold: 2,
    pauseHintDelayMs: 30000,
};

/**
 * Detects patterns in command history that might indicate user needs help.
 * Emits events when patterns are detected.
 */
export class EventDetector extends EventEmitter {
    #options: EventDetectorOptions;
    #recentCommands: CommandEntry[] = [];
    #lastActivityTime = Date.now();
    #lastErrorTime: number | null = null;
    #pauseTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: Partial<EventDetectorOptions> = {}) {
        super();
        this.#options = {...DEFAULT_OPTIONS, ...options};
    }

    /**
     * Get time since last activity in milliseconds.
     */
    get timeSinceLastActivity(): number {
        return Date.now() - this.#lastActivityTime;
    }

    /**
     * Process a new command entry and check for patterns.
     */
    processCommand(entry: CommandEntry): DetectedEvent | null {
        this.#recentCommands.unshift(entry);
        this.#lastActivityTime = Date.now();

        // Clear pause timer on new activity
        if (this.#pauseTimer) {
            clearTimeout(this.#pauseTimer);
            this.#pauseTimer = null;
        }

        // Keep only recent commands for pattern detection
        if (this.#recentCommands.length > 10) {
            this.#recentCommands = this.#recentCommands.slice(0, 10);
        }

        // Check for error cascade
        const cascadeEvent = this.#checkErrorCascade();
        if (cascadeEvent) {
            return cascadeEvent;
        }

        // Check for retry loop
        const retryEvent = this.#checkRetryLoop();
        if (retryEvent) {
            return retryEvent;
        }

        // Track error time for pause detection
        if (entry.exitCode !== 0) {
            this.#lastErrorTime = Date.now();
            this.#startPauseTimer();
        }

        return null;
    }

    /**
     * Mark user activity to reset pause detection.
     */
    markActivity(): void {
        this.#lastActivityTime = Date.now();
        if (this.#pauseTimer) {
            clearTimeout(this.#pauseTimer);
            this.#pauseTimer = null;
        }
    }

    /**
     * Get current detector options.
     */
    getOptions(): EventDetectorOptions {
        return {...this.#options};
    }

    /**
     * Update detector options.
     */
    setOptions(options: Partial<EventDetectorOptions>): void {
        this.#options = {...this.#options, ...options};
    }

    /**
     * Clear state.
     */
    clear(): void {
        this.#recentCommands = [];
        this.#lastActivityTime = Date.now();
        this.#lastErrorTime = null;
        if (this.#pauseTimer) {
            clearTimeout(this.#pauseTimer);
            this.#pauseTimer = null;
        }
    }

    /**
     * Check for consecutive command failures.
     */
    #checkErrorCascade(): DetectedEvent | null {
        const threshold = this.#options.errorCascadeThreshold;
        let consecutiveFailures = 0;

        for (const entry of this.#recentCommands) {
            if (entry.exitCode !== 0) {
                consecutiveFailures++;
            } else {
                break;
            }
        }

        if (consecutiveFailures >= threshold) {
            return {
                pattern: 'error_cascade',
                message: `Stuck? ${consecutiveFailures} commands failed. Type ?? for help.`,
                timestamp: Date.now(),
            };
        }

        return null;
    }

    /**
     * Check for repeated identical commands.
     */
    #checkRetryLoop(): DetectedEvent | null {
        const threshold = this.#options.retryLoopThreshold;
        if (this.#recentCommands.length < threshold) {
            return null;
        }

        const lastCommand = this.#recentCommands[0]?.command;
        if (!lastCommand) {
            return null;
        }

        let repeatCount = 0;
        for (const entry of this.#recentCommands) {
            if (entry.command === lastCommand) {
                repeatCount++;
            } else {
                break;
            }
        }

        if (repeatCount >= threshold) {
            return {
                pattern: 'retry_loop',
                message: `Same command run ${repeatCount} times. Try ?? why isn't this working`,
                timestamp: Date.now(),
            };
        }

        return null;
    }

    /**
     * Start timer for detecting long pause after error.
     */
    #startPauseTimer(): void {
        if (this.#pauseTimer) {
            clearTimeout(this.#pauseTimer);
        }

        this.#pauseTimer = setTimeout(() => {
            if (this.#lastErrorTime !== null) {
                const timeSinceError = Date.now() - this.#lastErrorTime;
                if (timeSinceError >= this.#options.pauseHintDelayMs) {
                    const event: DetectedEvent = {
                        pattern: 'long_pause',
                        message: 'Need help with that error?',
                        timestamp: Date.now(),
                    };
                    this.emit('hint', event);
                }
            }
            this.#pauseTimer = null;
        }, this.#options.pauseHintDelayMs);
    }
}
