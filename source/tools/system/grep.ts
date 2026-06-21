import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import {
  trimOutput,
  setTrimConfig,
  getTrimConfig,
  DEFAULT_TRIM_CONFIG,
  type OutputTrimConfig,
} from '../../utils/output/output-trim.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';

const execPromise = util.promisify(exec);

const searchParametersSchema = z.object({
  pattern: z.string().describe('Search pattern using normal JSON string escaping.'),
  path: z.string().describe('The directory or file to search in. Use "." for current directory.'),
  mode: z.enum(['regex', 'literal']).optional().describe('Search mode. Defaults to regex.'),
  case_sensitive: z.boolean().optional().describe('Set false for case-insensitive matching.'),
  file_pattern: z.string().optional().describe('Glob pattern for files to include (e.g., "*.ts").'),
  no_ignore: z
    .boolean()
    .optional()
    .describe('Set true to search files skipped by .gitignore/.ignore (e.g., node_modules, vendor, build output).'),
});

export type SearchToolParams = z.infer<typeof searchParametersSchema>;

// Re-export trim utilities for backwards compatibility
export { setTrimConfig, getTrimConfig, DEFAULT_TRIM_CONFIG, type OutputTrimConfig };

import { ExecutionContext } from '../../services/execution-context.js';
import { executeShellCommand } from '../../utils/shell/execute-shell.js';

let hasRg: boolean | null = null;
let hasRgRemote: boolean | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let source = '';

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];

    if (char === '*') {
      if (next === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`^${source}$`);
}

function matchesFilePattern(filePath: string, filePattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedPattern = filePattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const patternMatcher = globToRegExp(normalizedPattern);

  if (patternMatcher.test(normalizedPath)) {
    return true;
  }

  if (!normalizedPattern.includes('/')) {
    const basename = normalizedPath.split('/').pop() ?? normalizedPath;
    return patternMatcher.test(basename);
  }

  return false;
}

function filterGrepOutputByFilePattern(output: string, filePattern?: string): string {
  if (!filePattern) {
    return output;
  }

  return output
    .split('\n')
    .filter((line) => {
      const firstColon = line.indexOf(':');
      if (firstColon === -1) {
        return true;
      }

      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon === -1) {
        return true;
      }

      return matchesFilePattern(line.slice(0, firstColon), filePattern);
    })
    .join('\n');
}

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

const GREP_DESCRIPTION =
  'Search for text in the codebase. Uses normal JSON escaping. Regex mode is the default; use literal mode for exact fixed-string matching. ' +
  'Use this to find where a symbol, string, or pattern appears in files. ' +
  'Do NOT use this to list files by name (use find_files) or to explore relationships between files (use code_context_search). ' +
  'Returns up to 50 matches as path:line:matched_text, or a note if results are truncated.';
const GREP_DESCRIPTION_ORCHESTRATOR =
  "Search for a known symbol or string when you already have a target in mind (e.g., confirm a subagent's reference, locate a specific identifier). Uses normal JSON escaping. Regex mode is the default; use literal mode for exact fixed-string matching. " +
  'For broad codebase exploration or "where is X used" investigations, prefer delegating to an `explorer` subagent via `run_subagent`. ' +
  'Do NOT use this to list files by name (use find_files) or to explore relationships between files (use code_context_search). ' +
  'Returns up to 50 matches as path:line:matched_text, or a note if results are truncated.';

export const createGrepToolDefinition = (
  deps: { executionContext?: ExecutionContext; orchestratorMode?: boolean } = {},
): ToolDefinition<SearchToolParams> => {
  const { executionContext, orchestratorMode = false } = deps;
  return {
    name: 'grep',
    description: orchestratorMode ? GREP_DESCRIPTION_ORCHESTRATOR : GREP_DESCRIPTION,
    parameters: searchParametersSchema,
    argumentParsing: 'strict',
    needsApproval: () => false, // Search is read-only and safe
    execute: async (params) => {
      const { pattern, path: searchPath, mode = 'regex', case_sensitive = true, file_pattern, no_ignore } = params;

      // Validate pattern is not empty
      if (!pattern || pattern.trim() === '') {
        throw new Error('Search pattern cannot be empty. Please provide a valid search term.');
      }

      // Default values for removed parameters
      const exclude_pattern = null; // No exclusions (ripgrep respects .gitignore)
      const max_results = 50; // Lowered to reduce output size

      const useRg = await checkRgAvailability(executionContext);
      let command = '';

      const limit = max_results;

      if (useRg) {
        const args = ['rg', '--line-number', '--no-heading', '--color=never'];
        if (!case_sensitive) args.push('--ignore-case');
        if (mode === 'literal') args.push('--fixed-strings');
        if (no_ignore) args.push('--no-ignore');
        if (file_pattern && no_ignore) args.push('-g', `'${file_pattern}'`);
        if (exclude_pattern) args.push('-g', `'!${exclude_pattern}'`);

        // Shell-quote the pattern; do not regex-escape it.
        args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

        args.push(searchPath);
        command = args.join(' ');
      } else {
        // Fallback to grep
        const args = ['grep', '-r', '-n', '-I']; // -I to ignore binary
        if (!case_sensitive) args.push('-i');
        if (mode === 'literal') args.push('-F');
        if (file_pattern) args.push(`--include='${file_pattern}'`);
        if (exclude_pattern) args.push(`--exclude='${exclude_pattern}'`);

        // Shell-quote the pattern; do not regex-escape it.
        args.push(`'${pattern.replace(/'/g, "'\\''")}'`);

        args.push(searchPath);
        command = args.join(' ');
      }

      const cwd = executionContext?.getCwd() || process.cwd();
      const sshService = executionContext?.getSSHService();

      const result = await executeShellCommand(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        cwd,
        sshService,
      });

      if (result.exitCode === 1) {
        return 'No matches found.';
      }

      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(`Search failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      }

      const filteredStdout =
        useRg && !no_ignore ? filterGrepOutputByFilePattern(result.stdout, file_pattern) : result.stdout;
      const trimmed = filteredStdout.trim();
      const lineCount = trimmed ? trimmed.split('\n').length : 0;
      const outputTrimmed = trimOutput(trimmed, limit);

      if (lineCount > limit) {
        return `${outputTrimmed}\n\nNote: ${lineCount} lines exceed the ${limit}-line limit. Narrow your search (pattern, path, or file_pattern).`;
      }

      return outputTrimmed || 'No matches found.';
    },
    formatCommandMessage: formatGrepCommandMessage,
  };
};

export const formatGrepCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const parsedOutput = safeJsonParse(getOutputText(item));
  const rawItem = item?.rawItem ?? item;
  const lookupCallId = rawItem?.callId ?? rawItem?.id ?? item?.callId ?? item?.id ?? getCallIdFromItem(item);
  const fallbackArgs =
    lookupCallId && toolCallArgumentsById.has(lookupCallId) ? toolCallArgumentsById.get(lookupCallId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args =
    normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? parsedOutput?.arguments;
  const pattern = args?.pattern ?? '';
  const searchPath = args?.path ?? '.';
  const mode = args?.mode ?? 'regex';

  const parts = [`grep "${pattern}"`, `"${searchPath}"`];

  if (mode === 'literal') {
    parts.push('--literal');
  }

  if (args?.case_sensitive === true) {
    parts.push('--case-sensitive');
  } else if (args?.case_sensitive === false) {
    parts.push('--ignore-case');
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
      toolName: 'grep',
      toolArgs: args,
    }),
  ];
};
