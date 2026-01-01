import type {CommandEntry} from './context-buffer.js';

export type OutputType =
    | 'test_results'
    | 'build_output'
    | 'git_output'
    | 'npm_output'
    | 'error_output'
    | 'general';

/**
 * Classify the type of command output for better summarization.
 */
export function classifyOutputType(entry: CommandEntry): OutputType {
    const cmd = entry.command.toLowerCase().trim();

    // Test commands
    if (
        /^(npm test|yarn test|pnpm test|jest|vitest|ava|mocha|pytest|go test|cargo test)/.test(
            cmd,
        )
    ) {
        return 'test_results';
    }

    // Build commands
    if (
        /^(npm run build|yarn build|pnpm build|tsc|webpack|vite build|cargo build|go build|make)/.test(
            cmd,
        )
    ) {
        return 'build_output';
    }

    // Git commands
    if (/^git\s/.test(cmd)) {
        return 'git_output';
    }

    // NPM commands
    if (/^(npm|yarn|pnpm)\s/.test(cmd)) {
        return 'npm_output';
    }

    // Error indication
    if (entry.exitCode !== 0) {
        return 'error_output';
    }

    return 'general';
}

/**
 * Check if output should be summarized (vs returned as-is).
 */
export function shouldSummarize(entry: CommandEntry): boolean {
    // Small output: return as-is
    if (entry.outputLines < 50) {
        return false;
    }

    // Known simple commands: return as-is
    const simpleCommands =
        /^(cd|pwd|echo|which|true|false|ls|cat|head|tail|wc|date|whoami|hostname)(\s|$)/;
    if (simpleCommands.test(entry.command.toLowerCase())) {
        return false;
    }

    // Everything else: summarize
    return true;
}

/**
 * Get summarization prompt for the output type.
 */
export function getSummarizationPrompt(outputType: OutputType): string {
    const prompts: Record<OutputType, string> = {
        test_results: `Summarize test results:
- Total passed/failed/skipped
- Names of failing tests
- First error message for each failure
- Key stack trace lines (file:line only)`,

        build_output: `Summarize build output:
- Success or failure
- Error messages with file:line references
- Warning count (if any)`,

        git_output: `Summarize git output:
- Operation performed
- Files affected (count or list if few)
- Any conflicts or errors`,

        npm_output: `Summarize npm/package manager output:
- Operation (install/add/remove)
- Packages affected
- Any warnings or errors`,

        error_output: `Extract only errors and warnings:
- Error messages with context
- File:line references
- Omit successful operations`,

        general: `Summarize concisely in under 100 words:
- Success or failure
- Key results or errors
- Actionable next steps (if any)`,
    };

    return prompts[outputType];
}
