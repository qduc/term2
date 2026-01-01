/**
 * Context buffer for companion mode.
 * Stores recent commands and their outputs in a rolling window.
 */

export interface CommandEntry {
    command: string;
    output: string;
    exitCode: number;
    timestamp: number;
    outputLines: number;
}

export interface CommandIndexEntry {
    index: number;
    command: string;
    exitCode: number;
    relativeTime: string;
    outputLines: number;
    hasErrors: boolean;
}

export interface ContextBufferOptions {
    maxSize: number; // Maximum buffer size in bytes
    maxCommands: number; // Maximum number of commands to track
}

/**
 * Rolling buffer that stores command history with outputs.
 * Generates lightweight command index for AI context.
 */
export class ContextBuffer {
    #entries: CommandEntry[] = [];
    #maxSize: number;
    #maxCommands: number;
    #currentSize = 0;

    constructor(options: ContextBufferOptions) {
        this.#maxSize = options.maxSize;
        this.#maxCommands = options.maxCommands;
    }

    /**
     * Add a command entry to the buffer.
     */
    addEntry(entry: CommandEntry): void {
        const entrySize = this.#calculateEntrySize(entry);

        // Evict oldest entries if buffer would exceed max size
        while (
            this.#entries.length > 0 &&
            this.#currentSize + entrySize > this.#maxSize
        ) {
            const removed = this.#entries.pop();
            if (removed) {
                this.#currentSize -= this.#calculateEntrySize(removed);
            }
        }

        // Evict if we'd exceed max commands
        while (this.#entries.length >= this.#maxCommands) {
            const removed = this.#entries.pop();
            if (removed) {
                this.#currentSize -= this.#calculateEntrySize(removed);
            }
        }

        // Add new entry at the beginning (most recent first)
        this.#entries.unshift(entry);
        this.#currentSize += entrySize;
    }

    /**
     * Get entry by index (0 = most recent).
     */
    getEntry(index: number): CommandEntry | undefined {
        return this.#entries[index];
    }

    /**
     * Get the last N entries (most recent first).
     */
    getLastN(n: number): CommandEntry[] {
        return this.#entries.slice(0, Math.min(n, this.#entries.length));
    }

    /**
     * Search entries by command or output text.
     */
    search(pattern: string, limit = 5): CommandEntry[] {
        const lowerPattern = pattern.toLowerCase();
        return this.#entries
            .filter(
                entry =>
                    entry.command.toLowerCase().includes(lowerPattern) ||
                    entry.output.toLowerCase().includes(lowerPattern),
            )
            .slice(0, limit);
    }

    /**
     * Get lightweight command index for AI context.
     * This is always included in the AI's context window.
     */
    getIndex(): CommandIndexEntry[] {
        const now = Date.now();
        return this.#entries.map((entry, index) => ({
            index,
            command: entry.command,
            exitCode: entry.exitCode,
            relativeTime: this.#formatRelativeTime(now - entry.timestamp),
            outputLines: entry.outputLines,
            hasErrors: this.#detectErrors(entry),
        }));
    }

    /**
     * Get the total number of entries.
     */
    get length(): number {
        return this.#entries.length;
    }

    /**
     * Get the current buffer size in bytes.
     */
    get size(): number {
        return this.#currentSize;
    }

    /**
     * Clear all entries.
     */
    clear(): void {
        this.#entries = [];
        this.#currentSize = 0;
    }

    /**
     * Calculate the approximate size of an entry in bytes.
     *
     * Size calculation methodology:
     * - Command string length in bytes
     * - Output string length in bytes
     * - Fixed metadata overhead (100 bytes) accounts for:
     *   - exitCode: number (~8 bytes in V8)
     *   - timestamp: number (~8 bytes in V8)
     *   - outputLines: number (~8 bytes in V8)
     *   - Object overhead and references (~76 bytes estimated)
     *
     * This is intentionally conservative to ensure we don't exceed memory limits.
     */
    #calculateEntrySize(entry: CommandEntry): number {
        const METADATA_OVERHEAD_BYTES = 100;
        return (
            (entry.command?.length || 0) +
            (entry.output?.length || 0) +
            METADATA_OVERHEAD_BYTES
        );
    }

    /**
     * Format timestamp as relative time string.
     */
    #formatRelativeTime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) {
            return `${seconds}s ago`;
        }
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) {
            return `${minutes}m ago`;
        }
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }

    /**
     * Detect if an entry likely contains errors.
     */
    #detectErrors(entry: CommandEntry): boolean {
        if (entry.exitCode !== 0) {
            return true;
        }

        const output = entry.output.toLowerCase();
        const errorPatterns = [
            'error',
            'fail',
            'exception',
            'fatal',
            'critical',
            'cannot',
            "can't",
            'denied',
            'not found',
            'no such file',
        ];

        return errorPatterns.some(pattern => output.includes(pattern));
    }
}
