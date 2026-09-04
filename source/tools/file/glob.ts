import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { resolveWorkspacePath, relaxedNumber } from '../utils.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  isSuccessOutput,
} from '../format-helpers.js';
import { isSessionReadGranted } from '../../services/approval/session-read-access.js';
import type { SessionAccessState } from '../../services/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../services/session/nested-tool-compatibility-state.js';
import type { ISettingsService } from '../../services/service-interfaces.js';
import { resolveGlobSearchTarget } from './glob-target.js';

export { resolveGlobSearchTarget };

const execPromise = util.promisify(exec);

const findFilesParametersSchema = z.object({
  pattern: z.string().describe('Glob or filename pattern to search for (e.g., "*.ts", "src/**/*.ts", "README.md").'),
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
import { isScriptedToolCall } from '../../utils/output/bound-tool-result.js';

let hasFd: boolean | null = null;
let hasFdRemote: boolean | null = null;

/**
 * Result cap for a glob issued from inside a script.
 *
 * High enough that a script enumerating a source tree gets the whole tree,
 * while still bounding a pathological pattern.
 */
const SCRIPTED_GLOB_MAX_RESULTS = 5_000;

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

  const parts = [`glob "${pattern}"`];
  if (searchPath !== '.' && searchPath) {
    parts.push(`"${searchPath}"`);
  }
  if (maxResults) {
    parts.push(`--max ${maxResults}`);
  }

  const command = parts.join(' ');
  const output = getOutputText(item) || 'No output';
  const success = isSuccessOutput(output) && !output.startsWith('No files found');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'glob',
      toolArgs: args,
    }),
  ];
};

const GLOB_DESCRIPTION =
  'Search for files by name in the workspace. Useful for finding files by pattern, exploring project structure, or locating specific files. ' +
  'Use this when you know the file name or extension. ' +
  'Do NOT use this to search file contents (inside run_code, use tools.grep(...)) or to find related code from a symbol (use tools.code_context_search(...) inside run_code). ' +
  'Returns up to max_results matching file paths, one per line, or a note if truncated.';
const GLOB_DESCRIPTION_OUTSIDE =
  'Search for files by name on the filesystem. Useful for finding files by pattern, exploring directory structure, or locating specific files. ' +
  'Use this when you know the file name or extension. ' +
  'Do NOT use this to search file contents (inside run_code, use tools.grep(...)). ' +
  'Returns up to max_results matching file paths, one per line, or a note if truncated.';

export const createFindFilesToolDefinition = (
  deps: {
    executionContext?: ExecutionContext;
    allowOutsideWorkspace?: boolean;
    forceFindFallback?: boolean;
    /** Root clients receive this handle-owned capability. */
    sessionAccess?: SessionAccessState;
    /** Isolated legacy protocol for nested tools only. */
    nestedCompatibility?: NestedToolCompatibilityState;
    /** YOLO (autoApproveMode 'always') read bypass. */
    settingsService?: ISettingsService;
  } = {},
): ToolDefinition<typeof findFilesParametersSchema> => {
  const {
    executionContext,
    allowOutsideWorkspace = false,
    forceFindFallback = false,
    sessionAccess,
    nestedCompatibility,
    settingsService,
  } = deps;
  return {
    name: 'glob',
    scriptedReturnShape: '{ paths: string[], total: number, truncated: boolean }',
    description: allowOutsideWorkspace ? GLOB_DESCRIPTION_OUTSIDE : GLOB_DESCRIPTION,
    parameters: findFilesParametersSchema,
    canRequireApproval: true,
    parallelSafe: true,
    argumentParsing: 'strict',
    needsApproval: async (params, context) => {
      if (allowOutsideWorkspace) {
        return false;
      }

      // YOLO mode ('always') approves read-only operations without a prompt,
      // even outside the workspace. The shared tool wrapper applies the same
      // mode to mutating tools.
      if (settingsService?.get('shell.autoApproveMode') === 'always') {
        return false;
      }

      const { targetPath } = resolveGlobSearchTarget(params.pattern, params.path);
      try {
        const cwd = executionContext?.getCwd() || process.cwd();
        const resolvedPath = resolveWorkspacePath(targetPath, cwd, { allowOutsideWorkspace: true });
        if (isSessionReadGranted(resolvedPath, cwd, context, { sessionAccess, nestedCompatibility })) {
          return false;
        }

        resolveWorkspacePath(targetPath, cwd);
        return false;
      } catch {
        return true;
      }
    },
    execute: async (params, context) => {
      const { pattern: rawPattern, path: searchPath, max_results, no_ignore } = params;

      if (!rawPattern || rawPattern.trim() === '') {
        return 'Error: Search pattern cannot be empty. Please provide a valid file name or glob pattern.';
      }

      // A scripted call is not protected by the 50-result default: the list
      // goes to the script, not into model context, and a silently short list
      // makes whatever the script computes from it wrong. Observed in the
      // field test: a script asked for every file under source/tools, received
      // 50 of 86, and reported the wrong longest file
      // (docs/plans/code-mode-field-test.md).
      const limit = max_results ?? (isScriptedToolCall(context) ? SCRIPTED_GLOB_MAX_RESULTS : 50);
      const cwd = executionContext?.getCwd() || process.cwd();

      // When the pattern itself is an absolute path (e.g. "/data/llamacpp/models/run_*.sh"),
      // extract the directory as the search root and use only the basename as the glob pattern.
      const { pattern, targetPath } = resolveGlobSearchTarget(rawPattern, searchPath);

      // The workspace boundary is enforced by needsApproval in the default mode.
      const absolutePath = resolveWorkspacePath(targetPath, cwd, { allowOutsideWorkspace: true });

      const useFd = forceFindFallback ? false : await checkFdAvailability(executionContext);
      const escapedPattern = `'${pattern.replace(/'/g, "'\\''")}'`;
      const escapedPath = `'${absolutePath.replace(/'/g, "'\\''")}'`;

      let command: string;
      if (useFd) {
        const args = ['fd', '--color=never', '--type', 'f'];
        const hasPathSegment = patternHasPathSegments(pattern);
        if (hasPathSegment) {
          args.push('--full-path', '--glob');
          // If the pattern doesn't start with wildcard, dot or slash, prepend **/ to match absolute/relative paths
          let adjustedPattern = pattern;
          if (!pattern.startsWith('*') && !pattern.startsWith('.') && !pattern.startsWith('/')) {
            adjustedPattern = `**/${pattern}`;
          }
          const escapedAdjustedPattern = `'${adjustedPattern.replace(/'/g, "'\\''")}'`;
          args.push(escapedAdjustedPattern);
        } else {
          args.push('--glob', escapedPattern);
        }
        if (no_ignore) args.push('--no-ignore', '--hidden');
        args.push(escapedPath);
        command = args.join(' ');
      } else {
        const hasPathSegment = patternHasPathSegments(pattern);
        const matchArg = hasPathSegment ? '-path' : '-name';
        let normalizedPattern = pattern;
        if (hasPathSegment) {
          // In find -path, a single * matches directories recursively.
          // Translate glob **/ to * and /**/ to /
          normalizedPattern = pattern
            .replace(/\/\*\*\//g, '/')
            .replace(/\*\*\//g, '*/')
            .replace(/\/\*\*/g, '/*')
            .replace(/\*+/g, '*');
        }
        const matchPattern = hasPathSegment ? path.join(absolutePath, normalizedPattern).replace(/\\/g, '/') : pattern;
        const escapedMatchPattern = `'${matchPattern.replace(/'/g, "'\\''")}'`;
        command = ['find', escapedPath, '-type', 'f', matchArg, escapedMatchPattern].join(' ');
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
      const cleanedLines = trimmed
        ? trimmed
            .split('\n')
            .filter(Boolean)
            .map((line) => toRelative(line, absolutePath))
        : [];

      // A script gets fields, not prose. The text form signals "no matches" and
      // "results were capped" in sentences, which a script splitting on
      // newlines reads as more paths — the failure that made a model examine 33
      // of 51 files and miss the one it was asked for
      // (docs/plans/code-mode-field-test.md).
      if (isScriptedToolCall(context)) {
        return {
          paths: cleanedLines.slice(0, limit),
          total: cleanedLines.length,
          truncated: cleanedLines.length > limit,
        };
      }

      if (!trimmed) {
        return `No files found matching pattern: ${pattern}`;
      }

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
