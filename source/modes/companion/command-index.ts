/**
 * Command index utilities for companion mode.
 * Generates lightweight command summaries for AI context.
 */

import type {CommandIndexEntry} from './context-buffer.js';

/**
 * Format command index entries for inclusion in AI system prompt.
 * Produces a compact, readable representation that uses minimal tokens.
 *
 * Example output:
 * [0] npm test              ✗ exit:1    5s ago    (542 lines)
 * [1] git diff              ✓ exit:0    30s ago   (23 lines)
 * [2] npm install           ✓ exit:0    2m ago    (891 lines)
 */
export function formatCommandIndex(entries: CommandIndexEntry[]): string {
    if (entries.length === 0) {
        return 'No recent commands.';
    }

    return entries
        .map(entry => {
            const status = entry.exitCode === 0 ? '✓' : '✗';
            const cmd = entry.command.padEnd(25).slice(0, 25);
            return `[${entry.index}] ${cmd} ${status} exit:${entry.exitCode}  ${entry.relativeTime}  (${entry.outputLines} lines)`;
        })
        .join('\n');
}

/**
 * Generate system prompt section for command index.
 * This is always included in companion mode AI context.
 */
export function generateCommandIndexPrompt(
    entries: CommandIndexEntry[],
): string {
    const indexSection = formatCommandIndex(entries);

    return `
## Terminal Context

You are observing the user's terminal session. Here are the recent commands:

${indexSection}

Use the terminal_history tool to fetch detailed output when needed.
`;
}

/**
 * Estimate token count for command index.
 * Rough approximation: ~4 characters per token.
 */
export function estimateTokens(entries: CommandIndexEntry[]): number {
    const formatted = formatCommandIndex(entries);
    return Math.ceil(formatted.length / 4);
}
