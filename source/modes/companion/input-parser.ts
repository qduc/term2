/**
 * Input parser for companion mode.
 * Detects special commands like ?? and !auto in user input.
 */

export interface ParsedInput {
    type: 'query' | 'auto' | 'normal';
    content: string;
}

/**
 * Parse input line to detect ?? queries and !auto commands.
 */
export function parseCompanionInput(input: string): ParsedInput {
    const trimmed = input.trim();

    // Detect ?? query
    if (trimmed.startsWith('??')) {
        const query = trimmed.slice(2).trim();
        return {type: 'query', content: query};
    }

    // Detect !auto command
    if (trimmed.startsWith('!auto')) {
        const task = trimmed.slice(5).trim();
        return {type: 'auto', content: task};
    }

    // Normal input
    return {type: 'normal', content: trimmed};
}

/**
 * Check if a line looks like a shell prompt.
 * Used to detect when a command has completed.
 */
export function isShellPrompt(line: string): boolean {
    // Common shell prompt patterns
    const promptPatterns = [
        /\$\s*$/, // bash/sh: ends with $
        /%\s*$/, // zsh: ends with %
        />\s*$/, // some shells: ends with >
        /❯\s*$/, // oh-my-zsh/powerlevel: ends with ❯
        /→\s*$/, // some prompts: ends with →
        /^\[.+\]\s*[$%>❯→]\s*$/, // bracketed: [path]$
        /^.+@.+:.+[$%>❯→]\s*$/, // user@host:path$
    ];

    return promptPatterns.some(pattern => pattern.test(line));
}

/**
 * Extract command from prompt line.
 * Tries to separate the prompt from the actual command.
 */
export function extractCommandFromPromptLine(line: string): string | null {
    // Look for common prompt endings followed by command
    const promptEndings = ['$ ', '% ', '> ', '❯ ', '→ '];

    for (const ending of promptEndings) {
        const idx = line.lastIndexOf(ending);
        if (idx !== -1 && idx < line.length - 2) {
            return line.slice(idx + ending.length).trim();
        }
    }

    return null;
}

/**
 * Buffer for accumulating PTY output and detecting command boundaries.
 */
export class CommandOutputBuffer {
    #currentCommand: string | null = null;
    #outputBuffer: string = '';
    #promptLine: string = '';

    /**
     * Process incoming PTY data.
     * Returns completed command+output when a command boundary is detected.
     */
    processData(data: string): {
        command: string;
        output: string;
    } | null {
        // Accumulate output
        this.#outputBuffer += data;

        // Check for command boundary (new prompt)
        const lines = this.#outputBuffer.split('\n');
        const lastLine = lines[lines.length - 1] ?? '';

        if (isShellPrompt(lastLine) && this.#currentCommand) {
            // Command completed
            const result = {
                command: this.#currentCommand,
                output: this.#outputBuffer.slice(0, -lastLine.length).trim(),
            };

            // Reset for next command
            this.#currentCommand = null;
            this.#outputBuffer = lastLine;
            this.#promptLine = lastLine;

            return result;
        }

        return null;
    }

    /**
     * Mark start of a new command.
     */
    startCommand(command: string): void {
        this.#currentCommand = command;
        this.#outputBuffer = '';
    }

    /**
     * Get the current prompt line.
     */
    get promptLine(): string {
        return this.#promptLine;
    }

    /**
     * Check if currently waiting for command output.
     */
    get isWaitingForOutput(): boolean {
        return this.#currentCommand !== null;
    }

    /**
     * Clear the buffer.
     */
    clear(): void {
        this.#currentCommand = null;
        this.#outputBuffer = '';
        this.#promptLine = '';
    }
}
