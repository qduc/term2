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
import type {ToolDefinition} from './types.js';

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
        .optional()
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

let hasRg: boolean | null = null;

async function checkRgAvailability(): Promise<boolean> {
    if (hasRg !== null) return hasRg;
    try {
        await execPromise('rg --version');
        hasRg = true;
    } catch {
        hasRg = false;
    }
    return hasRg;
}

export const grepToolDefinition: ToolDefinition<SearchToolParams> = {
    name: 'grep',
    description:
        'Search for text in the codebase. Useful for exploring code, finding usages, etc.',
    parameters: searchParametersSchema,
    needsApproval: () => false, // Search is read-only and safe
    execute: async params => {
        const {pattern, path, file_pattern} = params;

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

        const useRg = await checkRgAvailability();
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
            // rg doesn't have a direct max results flag that stops searching globally easily across files in a simple way without piping,
            // but we can limit output length later or use `head`.
            // Actually `rg` has `--max-count` but that is per file.
            // We'll just run it and slice the output for simplicity and consistency.

            // Escape pattern
            args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

            args.push(path);
            command = args.join(' ');
        } else {
            // Fallback to grep
            const args = ['grep', '-r', '-n', '-I']; // -I to ignore binary
            if (!case_sensitive) args.push('-i');
            if (file_pattern) args.push(`--include='${file_pattern}'`);
            if (exclude_pattern) args.push(`--exclude='${exclude_pattern}'`);

            // Escape pattern
            args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

            args.push(path);
            command = args.join(' ');
        }

        try {
            const {stdout} = await execPromise(command, {
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
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
            // grep/rg returns exit code 1 if no matches found, which execPromise treats as error
            if (error.code === 1) {
                return 'No matches found.';
            }
            throw new Error(`Search failed: ${error.message}`);
        }
    },
};
