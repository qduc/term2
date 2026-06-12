import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { resolveWorkspacePath, relaxedNumber } from '../utils.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';

const execPromise = util.promisify(exec);

const findFilesParametersSchema = z.object({
  pattern: z
    .string()
    .describe(
      'Basename glob or filename to search for (e.g., "*.ts", "README.md"). Path segments are not allowed — use the `path` parameter to scope the directory.',
    ),
  path: z
    .string()
    .optional()
    .describe('Directory to search in. Use "." for current directory. Defaults to current directory.'),
  max_results: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return. Defaults to 50.'),
  no_ignore: z
    .boolean()
    .optional()
    .describe(
      'Set true to include files normally skipped by .gitignore/.ignore and hidden files (e.g., node_modules, .git, build output). Defaults to false. Only takes effect when fd is available.',
    ),
});

export type FindFilesToolParams = z.infer<typeof findFilesParametersSchema>;

import { ExecutionContext } from '../../services/execution-context.js';
import { executeShellCommand } from '../../utils/shell/execute-shell.js';

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

export const formatFindFilesCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
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
      const { pattern, path: searchPath, max_results, no_ignore } = params;

      if (!pattern || pattern.trim() === '') {
        return 'Error: Search pattern cannot be empty. Please provide a valid file name or glob pattern.';
      }

      if (patternHasPathSegments(pattern)) {
        return 'Error: pattern must be basename-only (e.g., "*.ts", "README.md"). Use the `path` parameter to scope the directory. To search outside the workspace, use the shell tool.';
      }

      const limit = max_results ?? 50;
      const targetPath = searchPath?.trim() || '.';
      const cwd = executionContext?.getCwd() || process.cwd();

      let absolutePath: string;
      try {
        // In Lite Mode we may allow searching outside the current workspace.
        absolutePath = resolveWorkspacePath(targetPath, cwd, { allowOutsideWorkspace });
      } catch (error: any) {
        if (error.message?.includes('outside workspace')) {
          return `Error: ${error.message}`;
        }
        throw error;
      }

      const useFd = forceFindFallback ? false : await checkFdAvailability(executionContext);
      const escapedPattern = `'${pattern.replace(/'/g, "'\\''")}'`;
      const escapedPath = `'${absolutePath.replace(/'/g, "'\\''")}'`;

      let command: string;
      if (useFd) {
        const args = ['fd', '--color=never', '--type', 'f', '--glob'];
        if (no_ignore) args.push('--no-ignore', '--hidden');
        args.push(escapedPattern, escapedPath);
        command = args.join(' ');
      } else {
        // find pushes the glob down via -name so we don't enumerate the whole tree.
        command = ['find', escapedPath, '-type', 'f', '-name', escapedPattern].join(' ');
      }

      const sshService = executionContext?.getSSHService();
      const result = await executeShellCommand(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        cwd,
        sshService,
      });

      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(`File search failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      }

      const trimmed = result.stdout.trim();
      if (!trimmed) {
        return `No files found matching pattern: ${pattern}`;
      }

      const cleanedLines = trimmed
        .split('\n')
        .filter(Boolean)
        .map((line) => toRelative(line, absolutePath));

      let resultText = cleanedLines.slice(0, limit).join('\n');
      if (cleanedLines.length > limit) {
        resultText += `\n\nNote: Results limited to ${limit} files. Found ${cleanedLines.length} total matches. Use max_results parameter to see more.`;
      }

      return resultText;
    },
    formatCommandMessage: formatFindFilesCommandMessage,
  };
};

function patternHasPathSegments(pattern: string): boolean {
  return pattern.replace(/\\/g, '/').includes('/');
}

function toRelative(line: string, absolutePath: string): string {
  const normalized = line.replace(/\\/g, '/');
  if (normalized.startsWith('./')) return normalized.slice(2);
  const root = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = path.posix.relative(root, normalized);
  return rel || normalized;
}
