import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { resolveWorkspacePath, relaxedNumber } from './utils.js';
import type { ToolDefinition, CommandMessage } from './types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from './format-helpers.js';

const execPromise = util.promisify(exec);

const findFilesParametersSchema = z.object({
  pattern: z.string().describe('Glob pattern or filename to search for (e.g., "*.ts", "**/*.test.ts", "README.md")'),
  path: z
    .string()
    .optional()
    .describe('Directory to search in. Use "." for current directory. Defaults to current directory.'),
  max_results: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return. Defaults to 50.'),
});

export type FindFilesToolParams = z.infer<typeof findFilesParametersSchema>;

import { ExecutionContext } from '../services/execution-context.js';
import { executeShellCommand } from '../utils/execute-shell.js';

let hasFd: boolean | null = null;
let hasFdRemote: boolean | null = null;

async function checkFdAvailability(executionContext?: ExecutionContext): Promise<boolean> {
  const isRemote = executionContext?.isRemote() ?? false;

  if (isRemote) {
    if (hasFdRemote !== null) return hasFdRemote;
    try {
      const sshService = executionContext?.getSSHService();
      if (!sshService) return false;
      await sshService.executeCommand('fd --version');
      hasFdRemote = true;
    } catch {
      hasFdRemote = false;
    }
    return hasFdRemote;
  } else {
    if (hasFd !== null) return hasFd;
    try {
      await execPromise('fd --version');
      hasFd = true;
    } catch {
      hasFd = false;
    }
    return hasFd;
  }
}

export const formatFindFilesCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const pattern = args?.pattern ?? '';
  const searchPath = args?.path ?? '.';
  const maxResults = args?.max_results;

  const parts = [`find_files "${pattern}"`];
  if (searchPath !== '.' && searchPath) {
    parts.push(`"${searchPath}"`);
  }
  if (maxResults) {
    parts.push(`--max ${maxResults}`);
  }

  const command = parts.join(' ');
  const output = getOutputText(item) || 'No output';
  const success = !output.startsWith('Error:') && !output.startsWith('No files found');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'find_files',
      toolArgs: args,
    }),
  ];
};

export const createFindFilesToolDefinition = (
  deps: {
    executionContext?: ExecutionContext;
    allowOutsideWorkspace?: boolean;
    forceFindFallback?: boolean;
  } = {},
): ToolDefinition<FindFilesToolParams> => {
  const { executionContext, allowOutsideWorkspace = false, forceFindFallback = false } = deps;
  return {
    name: 'find_files',
    description: allowOutsideWorkspace
      ? 'Search for files by name on the filesystem. Useful for finding files by pattern, exploring directory structure, or locating specific files.'
      : 'Search for files by name in the workspace. Useful for finding files by pattern, exploring project structure, or locating specific files.',
    parameters: findFilesParametersSchema,
    needsApproval: () => false, // Search is read-only and safe
    execute: async (params) => {
      const { pattern, path: searchPath, max_results } = params;

      // Validate pattern is not empty
      if (!pattern || pattern.trim() === '') {
        return 'Error: Search pattern cannot be empty. Please provide a valid file name or glob pattern.';
      }

      const limit = max_results ?? 50;
      const targetPath = searchPath?.trim() || '.';
      const cwd = executionContext?.getCwd() || process.cwd();

      try {
        // In Lite Mode we may allow searching outside the current workspace.
        const absolutePath = resolveWorkspacePath(targetPath, cwd, {
          allowOutsideWorkspace,
        });

        const useFd = forceFindFallback ? false : await checkFdAvailability(executionContext);
        const isRemote = executionContext?.isRemote() ?? false;

        if (isRemote && !useFd && patternHasPathSegments(pattern)) {
          return 'Error: SSH search without fd does not support path segments in the pattern. Use the path parameter with a basename glob like "*.ts" or "*" instead.';
        }
        let command = '';

        if (useFd) {
          // Use fd (faster and more user-friendly)
          const args = [
            'fd',
            '--color=never',
            '--type',
            'f', // files only
            '--glob', // use glob pattern matching
          ];

          // Escape pattern for shell
          args.push(`'${pattern.replace(/'/g, "'\\''")}'`);
          args.push(`'${absolutePath.replace(/'/g, "'\\''")}'`);

          command = args.join(' ');
        } else {
          // Fallback to find (list all files; filter in JS to match fd glob semantics)
          const args = ['find', `'${absolutePath.replace(/'/g, "'\\''")}'`, '-type', 'f'];
          command = args.join(' ');
        }

        const sshService = executionContext?.getSSHService();

        const result = await executeShellCommand(command, {
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          cwd,
          sshService,
        });

        if (result.exitCode === 1) {
          return `No files found matching pattern: ${pattern}`;
        }

        if (result.exitCode !== 0 && result.exitCode !== null) {
          throw new Error(result.stderr || 'Unknown error');
        }

        const trimmed = result.stdout.trim();

        if (!trimmed) {
          return `No files found matching pattern: ${pattern}`;
        }

        const lines = trimmed.split('\n');
        const cleanedLines = useFd
          ? lines.map((line) => (line.startsWith('./') ? line.substring(2) : line))
          : filterFindResults(lines, absolutePath, pattern);

        if (cleanedLines.length === 0) {
          return `No files found matching pattern: ${pattern}`;
        }

        // Apply limit
        let resultText = cleanedLines.slice(0, limit).join('\n');

        // Add note if results were truncated
        if (cleanedLines.length > limit) {
          resultText += `\n\nNote: Results limited to ${limit} files. Found ${cleanedLines.length} total matches. Use max_results parameter to see more.`;
        }

        return resultText;
      } catch (error: any) {
        // Handle path resolution errors
        if (error.message?.includes('outside workspace')) {
          return `Error: ${error.message}`;
        }

        // fd/find returns exit code 1 if no matches found
        if (error.code === 1) {
          return `No files found matching pattern: ${pattern}`;
        }

        // Handle other errors
        return `Error: ${error.message || String(error)}`;
      }
    },
    formatCommandMessage: formatFindFilesCommandMessage,
  };
};

function filterFindResults(lines: string[], absolutePath: string, pattern: string): string[] {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const patternHasSlash = normalizedPattern.includes('/');
  const matcher = globToRegex(normalizedPattern);
  const root = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');

  const results: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    const normalizedLine = line.replace(/\\/g, '/');
    const relative = path.posix.relative(root, normalizedLine);
    if (relative.startsWith('..')) continue;
    const target = patternHasSlash ? relative : path.posix.basename(relative);
    if (matcher.test(target)) {
      results.push(relative);
    }
  }

  return results;
}

function patternHasPathSegments(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  return normalized.includes('/');
}

function globToRegex(pattern: string): RegExp {
  let regex = '^';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*';
      if (isDoubleStar) {
        const nextChar = pattern[index + 2];
        if (nextChar === '/') {
          regex += '(?:.*/)?';
          index += 2;
        } else {
          while (pattern[index + 1] === '*') {
            index += 1;
          }
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else if (char === '[') {
      const endIndex = pattern.indexOf(']', index + 1);
      if (endIndex === -1) {
        regex += '\\[';
      } else {
        const content = pattern.slice(index + 1, endIndex);
        const escaped = content.replace(/\\/g, '\\\\');
        regex += `[${escaped}]`;
        index = endIndex;
      }
    } else {
      regex += escapeRegexChar(char);
    }
    index += 1;
  }

  regex += '$';
  return new RegExp(regex);
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
}
