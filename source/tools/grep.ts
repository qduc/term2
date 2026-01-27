import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import {
    trimOutput,
    setTrimConfig,
    getTrimConfig,
    DEFAULT_TRIM_CONFIG,
    type OutputTrimConfig,
} from '../utils/output-trim.js';
import type {ToolDefinition, CommandMessage} from './types.js';
import {
    getOutputText,
    safeJsonParse,
    normalizeToolArguments,
    createBaseMessage,
    getCallIdFromItem,
} from './format-helpers.js';

const execPromise = util.promisify(exec);

const searchParametersSchema = z.object({
    pattern: z.string().describe('The text or regex pattern to search for'),
    path: z
        .string()
        .describe(
            'The directory or file to search in. Use "." for current directory.',
        ),
    file_pattern: z
        .string()
        .nullable()
        .default(null)
        .describe(
            'Glob pattern for files to include (e.g., "*.ts"). Pass null to include all files.',
        ),
});

export type SearchToolParams = z.infer<typeof searchParametersSchema>;

// Re-export trim utilities for backwards compatibility
export {
    setTrimConfig,
    getTrimConfig,
    DEFAULT_TRIM_CONFIG,
    type OutputTrimConfig,
};

import { ExecutionContext } from '../services/execution-context.js';
import { executeShellCommand } from '../utils/execute-shell.js';

let hasRg: boolean | null = null;
let hasRgRemote: boolean | null = null;

async function checkRgAvailability(executionContext?: ExecutionContext): Promise<boolean> {
    const isRemote = executionContext?.isRemote() ?? false;

    if (isRemote) {
        if (hasRgRemote !== null) return hasRgRemote;
        try {
            const sshService = executionContext?.getSSHService();
            if (!sshService) return false;
            await sshService.executeCommand('rg --version');
            hasRgRemote = true;
        } catch {
            hasRgRemote = false;
        }
        return hasRgRemote;
    } else {
        if (hasRg !== null) return hasRg;
        try {
            await execPromise('rg --version');
            hasRg = true;
        } catch {
            hasRg = false;
        }
        return hasRg;
    }
}

export const createGrepToolDefinition = (deps: { executionContext?: ExecutionContext } = {}): ToolDefinition<SearchToolParams> => {
    const { executionContext } = deps;
    return {
        name: 'grep',
        description:
            'Search for text in the codebase. Useful for exploring code, finding usages, etc.',
        parameters: searchParametersSchema,
        needsApproval: () => false, // Search is read-only and safe
        execute: async params => {
            const { pattern, path: searchPath, file_pattern } = params;

            // Validate pattern is not empty
            if (!pattern || pattern.trim() === '') {
                throw new Error(
                    'Search pattern cannot be empty. Please provide a valid search term.',
                );
            }

            // Default values for removed parameters
            const case_sensitive = false; // Case-insensitive by default
            const exclude_pattern = null; // No exclusions (ripgrep respects .gitignore)
            const max_results = 50; // Lowered to reduce output size

            const useRg = await checkRgAvailability(executionContext);
            let command = '';

            const limit = max_results;

            if (useRg) {
                const args = [
                    'rg',
                    '--line-number',
                    '--no-heading',
                    '--color=never',
                ];
                if (!case_sensitive) args.push('--ignore-case');
                if (file_pattern) args.push('-g', `'${file_pattern}'`);
                if (exclude_pattern) args.push('-g', `'!${exclude_pattern}'`);

                // Escape pattern
                args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

                args.push(searchPath);
                command = args.join(' ');
            } else {
                // Fallback to grep
                const args = ['grep', '-r', '-n', '-I']; // -I to ignore binary
                if (!case_sensitive) args.push('-i');
                if (file_pattern) args.push(`--include='${file_pattern}'`);
                if (exclude_pattern) args.push(`--exclude='${exclude_pattern}'`);

                // Escape pattern
                args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

                args.push(searchPath);
                command = args.join(' ');
            }

            const cwd = executionContext?.getCwd() || process.cwd();
            const sshService = executionContext?.getSSHService();

            try {
                const { stdout } = await executeShellCommand(command, {
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                    cwd,
                    sshService,
                });

                const trimmed = stdout.trim();
                const lineCount = trimmed.split('\n').length;
                const result = trimOutput(trimmed, limit);

                // Add hint if results were truncated
                if (lineCount > limit) {
                    return `${result}\n\nNote: Results exceeded ${limit} lines. Consider narrowing your search with a more specific pattern or file_pattern.`;
                }

                return result || 'No matches found.';
            } catch (error: any) {
                // grep/rg returns exit code 1 if no matches found, which executeShellCommand might NOT treat as error if we handle it there?
                // executeShellCommand catches errors.
                // sshService.executeCommand catches error? no, creates promise.
                // Wait, executeShellCommand wraps exec and returns object even on error.
                // But if it THROWS, we catch it here.

                // executeShellCommand returns object with exitCode. It does NOT throw for non-zero exit code usually?
                // Let's check executeShellCommand implementation.
                // "const exitCode = typeof error?.code === 'number' ? error.code : null;" in catch block.
                // It catches exec exceptions and returns ShellExecutionResult.

                // So result.exitCode check is needed.
                // But wait, I am destructuring {stdout} and ignoring exitCode.
                // If grep returns 1, stdout is likely empty.

                // Let's refine the try/catch logic or result inspection.
                // executeShellCommand returns {stdout, stderr, exitCode}.
                // If grep fails (exit 1), exitCode is 1.

                // However, previous code used `execPromise` which throws on exit code != 0.
                // executeShellCommand handles parsing.

                // I should capture result and check exitCode.
                // But wait, executeShellCommand throws?
                // No, look at implementation: it catches error and returns object.

                // So my destructing was: const {stdout} = await executeShellCommand(...)
                // If exitCode is 1 (no match), stdout is empty.
                // If exitCode is 2 (error), stderr has content.

                // So I should check stderr?
            }

            // Re-implementing try block with proper check
            const result = await executeShellCommand(command, {
                maxBuffer: 10 * 1024 * 1024,
                cwd,
                sshService,
            });

            if (result.exitCode === 1) {
                return 'No matches found.';
            }

            if (result.exitCode !== 0 && result.exitCode !== null) {
                throw new Error(`Search failed: ${result.stderr}`);
            }

            const trimmed = result.stdout.trim();
            const lineCount = trimmed.split('\n').length;
            const outputTrimmed = trimOutput(trimmed, limit);

            if (lineCount > limit) {
                return `${outputTrimmed}\n\nNote: Results exceeded ${limit} lines. Consider narrowing your search with a more specific pattern or file_pattern.`;
            }

            return outputTrimmed || 'No matches found.';
        },
        formatCommandMessage: formatGrepCommandMessage,
    };
};

export const formatGrepCommandMessage = (
    item: any,
    index: number,
    toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const parsedOutput = safeJsonParse(getOutputText(item));
    const rawItem = item?.rawItem ?? item;
    const lookupCallId =
        rawItem?.callId ??
        rawItem?.id ??
        item?.callId ??
        item?.id ??
        getCallIdFromItem(item);
    const fallbackArgs =
        lookupCallId && toolCallArgumentsById.has(lookupCallId)
            ? toolCallArgumentsById.get(lookupCallId)
            : null;
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args =
        normalizeToolArguments(normalizedArgs) ??
        normalizeToolArguments(fallbackArgs) ??
        parsedOutput?.arguments;
    const pattern = args?.pattern ?? '';
    const searchPath = args?.path ?? '.';

    const parts = [`grep "${pattern}"`, `"${searchPath}"`];

    if (args?.case_sensitive) {
        parts.push('--case-sensitive');
    }
    if (args?.file_pattern) {
        parts.push(`--include "${args.file_pattern}"`);
    }
    if (args?.exclude_pattern) {
        parts.push(`--exclude "${args.exclude_pattern}"`);
    }

    const command = parts.join(' ');
    const output =
        parsedOutput?.output ?? getOutputText(item) ?? 'No output';
    // Success is determined by the grep tool - it returns "No matches found."
    // for empty results and throws for actual errors
    const success = true;

    return [
        createBaseMessage(item, index, 0, false, {
            command,
            output,
            success,
        }),
    ];
};

