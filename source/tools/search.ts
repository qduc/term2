import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import { relaxedNumber } from './utils.js';
import {
  trimOutput,
  setTrimConfig,
  getTrimConfig,
  DEFAULT_TRIM_CONFIG,
  type OutputTrimConfig,
} from '../utils/output-trim.js';
import type { ToolDefinition, CommandMessage } from './types.js';
import { getOutputText, safeJsonParse, normalizeToolArguments, createBaseMessage } from './format-helpers.js';

const execPromise = util.promisify(exec);

const searchParametersSchema = z.object({
  pattern: z.string().describe('The text or regex pattern to search for'),
  path: z.string().describe('The directory or file to search in. Use "." for current directory.'),
  case_sensitive: z.boolean().optional().default(true).describe('Whether the search should be case sensitive.'),
  file_pattern: z.string().optional().describe('Glob pattern for files to include (e.g., "*.ts").'),
  exclude_pattern: z.string().optional().describe('Glob pattern for files to exclude.'),
  max_results: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return. Defaults to 100.'),
});

export type SearchToolParams = z.infer<typeof searchParametersSchema>;

// Re-export trim utilities for backwards compatibility
export { setTrimConfig, getTrimConfig, DEFAULT_TRIM_CONFIG, type OutputTrimConfig };

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

const formatSearchCommandMessage = (
  item: any,
  index: number,
  _toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const parsedOutput = safeJsonParse(getOutputText(item));
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? parsedOutput?.arguments ?? {};
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
  const output = parsedOutput?.output ?? getOutputText(item) ?? 'No output';
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

export const grepToolDefinition: ToolDefinition<SearchToolParams> = {
  name: 'grep',
  description:
    'Search for text in the codebase using ripgrep (rg) if available, falling back to grep. Useful for exploring code, finding usages, etc.',
  parameters: searchParametersSchema,
  needsApproval: () => false, // Search is read-only and safe
  execute: async (params) => {
    const { pattern, path, case_sensitive, file_pattern, exclude_pattern, max_results } = params;
    const useRg = await checkRgAvailability();
    let command = '';

    const limit = max_results ?? 100;

    if (useRg) {
      const args = ['rg', '--line-number', '--no-heading', '--color=never'];
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
      const { stdout } = await execPromise(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      const result = trimOutput(stdout.trim(), limit);

      return JSON.stringify({
        arguments: params,
        output: result,
      });
    } catch (error: any) {
      // grep/rg returns exit code 1 if no matches found, which execPromise treats as error
      if (error.code === 1) {
        return JSON.stringify({
          arguments: params,
          output: 'No matches found.',
        });
      }
      throw new Error(`Search failed: ${error.message}`);
    }
  },
  formatCommandMessage: formatSearchCommandMessage,
};
