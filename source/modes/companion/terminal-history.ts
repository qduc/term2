import {z} from 'zod';
import type {ToolDefinition, CommandMessage} from '../../tools/types.js';
import type {ContextBuffer, CommandEntry} from './context-buffer.js';
import type {Summarizer} from './summarizer.js';
import {shouldSummarize} from './output-classifier.js';
import {randomUUID} from 'node:crypto';

const TerminalHistoryParamsSchema = z.object({
    index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Specific command by index (0 = most recent)'),
    lastN: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Fetch last N commands (default: 3)'),
    search: z
        .string()
        .optional()
        .describe('Search pattern for command or output text'),
    detail: z
        .enum(['summary', 'full', 'errors_only'])
        .describe('Level of detail to return'),
    maxLines: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum output lines to return'),
});

export type TerminalHistoryParams = z.infer<typeof TerminalHistoryParamsSchema>;

interface TerminalHistoryResult {
    command: string;
    exitCode: number;
    timestamp: number;
    output: string;
}

interface TerminalHistoryDeps {
    contextBuffer: ContextBuffer;
    summarizer: Summarizer;
}

/**
 * Create the terminal_history tool definition for companion mode.
 * This tool allows the AI to query command history and outputs on-demand.
 */
export function createTerminalHistoryToolDefinition(
    deps: TerminalHistoryDeps,
): ToolDefinition<TerminalHistoryParams> {
    const {contextBuffer, summarizer} = deps;

    return {
        name: 'terminal_history',
        description: `Query the terminal command history. Use this to get details about recent commands and their outputs.

Available in the command index (always visible):
- Command text
- Exit code (0 = success)
- Relative time
- Output line count

Use this tool to fetch:
- Full command output
- Summarized output (for long outputs)
- Errors only (filtered view)`,

        parameters: TerminalHistoryParamsSchema,

        // Read-only tool - never needs approval
        needsApproval: () => false,

        execute: async (params: TerminalHistoryParams) => {
            const {index, lastN = 3, search, detail, maxLines} = params;

            // Fetch entries from buffer
            let entries: (CommandEntry | undefined)[];

            if (index !== undefined) {
                entries = [contextBuffer.getEntry(index)];
            } else if (search) {
                entries = contextBuffer.search(search, lastN);
            } else {
                entries = contextBuffer.getLastN(lastN);
            }

            // Filter out undefined entries
            const validEntries = entries.filter(
                (e): e is CommandEntry => e !== undefined,
            );

            if (validEntries.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: 'No matching commands found',
                });
            }

            // Process based on detail level
            const results: TerminalHistoryResult[] = await Promise.all(
                validEntries.map(async entry => {
                    let output: string;

                    if (detail === 'full') {
                        output = entry.output;
                        if (maxLines && entry.output.split('\n').length > maxLines) {
                            const lines = entry.output.split('\n');
                            output = [
                                ...lines.slice(0, maxLines),
                                `... (${lines.length - maxLines} more lines)`,
                            ].join('\n');
                        }
                    } else if (shouldSummarize(entry)) {
                        output = await summarizer.summarize(entry, detail);
                    } else {
                        output = entry.output;
                    }

                    return {
                        command: entry.command,
                        exitCode: entry.exitCode,
                        timestamp: entry.timestamp,
                        output,
                    };
                }),
            );

            return JSON.stringify({success: true, results});
        },

        formatCommandMessage: (
            item: any,
            index: number,
            toolCallArgumentsById: Map<string, unknown>,
        ): CommandMessage[] => {
            const callId =
                item?.callId ||
                item?.rawItem?.callId ||
                item?.rawItem?.call_id;
            const args = callId
                ? (toolCallArgumentsById.get(callId) as TerminalHistoryParams)
                : null;

            let output = '';
            try {
                const parsed = JSON.parse(item?.output || '{}');
                if (parsed.results) {
                    output = parsed.results
                        .map(
                            (r: TerminalHistoryResult) =>
                                `[${r.command}] (exit: ${r.exitCode})\n${r.output}`,
                        )
                        .join('\n\n');
                } else if (parsed.error) {
                    output = `Error: ${parsed.error}`;
                }
            } catch {
                output = item?.output || 'No results';
            }

            return [
                {
                    id: `terminal-history-${index}-${randomUUID().slice(0, 8)}`,
                    sender: 'command',
                    status: 'completed',
                    command: `terminal_history(${args?.detail || 'query'})`,
                    output,
                    success: true,
                    toolName: 'terminal_history',
                    toolArgs: args,
                    callId,
                },
            ];
        },
    };
}
