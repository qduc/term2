import { z } from 'zod';
import { exec } from 'child_process';
import { homedir } from 'node:os';
import util from 'util';
import {
  trimOutput,
  setTrimConfig,
  getTrimConfig,
  DEFAULT_TRIM_CONFIG,
  type OutputTrimConfig,
} from '../../utils/output/output-trim.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { isSessionReadGranted } from '../../services/approval/session-read-access.js';
import type { SessionAccessState } from '../../services/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../services/session/nested-tool-compatibility-state.js';
import type { ISettingsService } from '../../services/service-interfaces.js';
import { resolveWorkspacePath } from '../utils.js';
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
  fixed_strings: z
    .boolean()
    .optional()
    .describe(
      'Interpret pattern as a fixed string instead of a regular expression (equivalent to -F / --fixed-strings).',
    ),
  ignore_case: z.boolean().optional().describe('Search case-insensitively (equivalent to -i / --ignore-case).'),
  include: z
    .string()
    .optional()
    .describe("Search only files matching the glob pattern (equivalent to grep's --include or ripgrep's -g)."),
  exclude: z
    .string()
    .optional()
    .describe("Skip files matching the glob pattern (equivalent to grep's --exclude or ripgrep's -g '!GLOB')."),
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

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Local commands must not rely on the child shell's HOME: sandboxed or
// containerized shells can resolve `~` to a different user (for example
// /root). Remote commands intentionally leave it for the remote shell, whose
// home directory is not available to the local process.
function shellQuoteSearchPath(value: string, isRemote: boolean): string {
  if (!isRemote) {
    const expandedPath = value.startsWith('~') ? value.replace(/^~/, homedir()) : value;
    return shellQuoteArg(expandedPath);
  }

  if (value === '~') {
    return value;
  }
  if (value.startsWith('~/')) {
    return `~/${shellQuoteArg(value.slice(2))}`;
  }
  return shellQuoteArg(value);
}

function expandBraces(pattern: string): string[] {
  const braceRegex = /\{([^}]+)\}/;
  const match = braceRegex.exec(pattern);
  if (!match) {
    return [pattern];
  }

  const [fullMatch, braceContent] = match;
  const options = braceContent.split(',');
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + fullMatch.length);

  const results: string[] = [];
  for (const option of options) {
    const expanded = prefix + option + suffix;
    results.push(...expandBraces(expanded));
  }
  return results;
}

// ripgrep rejects patterns that can match a line terminator unless multiline
// mode is enabled. Models commonly express a cross-line regex as `\\n`, which
// reaches this function as the two characters backslash+n (and is interpreted
// by ripgrep as a line terminator). Enable multiline mode for those patterns so
// a valid search does not become a tool error.
function patternMayMatchLineTerminator(pattern: string): boolean {
  return (
    pattern.includes('\n') ||
    pattern.includes('\r') ||
    pattern.includes('\\n') ||
    pattern.includes('\\r') ||
    /\\x(?:0a|0d|\{0*[ad]\})/i.test(pattern) ||
    /\\u(?:000a|000d)/i.test(pattern)
  );
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

const buildGrepDescription = (globAvailable: boolean, orchestratorMode: boolean): string => {
  const fileListTool = globAvailable ? 'glob' : 'shell';
  const base =
    'Search for text in the codebase. Uses normal JSON escaping. Regex mode is the default; use literal mode for exact fixed-string matching. ' +
    'Use this to find where a symbol, string, or pattern appears in files. ' +
    `Do NOT use this to list files by name (use ${fileListTool}) or to explore relationships between files (use code_context_search). ` +
    'Returns up to 50 matches as path:line:matched_text, or a note if results are truncated.';
  if (!orchestratorMode) {
    return base;
  }
  return (
    'Search directly for a symbol, string, or pattern in the codebase. Uses normal JSON escaping. Regex mode is the default; use literal mode for exact fixed-string matching. ' +
    'Delegate broad or separable investigation when it provides meaningful context compression or specialization. ' +
    `Do NOT use this to list files by name (use ${fileListTool}) or to explore relationships between files (use code_context_search). ` +
    'Returns up to 50 matches as path:line:matched_text, or a note if results are truncated.'
  );
};

export const createGrepToolDefinition = (
  deps: {
    executionContext?: ExecutionContext;
    orchestratorMode?: boolean;
    globAvailable?: boolean;
    allowOutsideWorkspace?: boolean;
    /** Root clients receive this handle-owned capability. */
    sessionAccess?: SessionAccessState;
    /** Isolated legacy protocol for nested tools only. */
    nestedCompatibility?: NestedToolCompatibilityState;
    /** YOLO (autoApproveMode 'always') read bypass. */
    settingsService?: ISettingsService;
  } = {},
): ToolDefinition<typeof searchParametersSchema> => {
  const {
    executionContext,
    orchestratorMode = false,
    globAvailable = true,
    allowOutsideWorkspace = false,
    sessionAccess,
    nestedCompatibility,
    settingsService,
  } = deps;
  return {
    name: 'grep',
    description: buildGrepDescription(globAvailable, orchestratorMode),
    parameters: searchParametersSchema,
    parallelSafe: true,
    argumentParsing: 'strict',
    // Read-only, but not necessarily in-bounds: `path` is passed through to a
    // shell `rg`/`grep -r` invocation, so an out-of-workspace path is an
    // unapproved filesystem read. Mirrors the glob tool's boundary check.
    needsApproval: async (params, context) => {
      if (allowOutsideWorkspace) {
        return false;
      }

      // YOLO mode ('always') approves read-only operations without a prompt,
      // even outside the workspace. Write tools never consult this mode, so
      // write authority is unchanged.
      if (settingsService?.get('shell.autoApproveMode') === 'always') {
        return false;
      }

      const searchPath = params.path?.trim() || '.';
      try {
        const cwd = executionContext?.getCwd() || process.cwd();
        const resolvedPath = resolveWorkspacePath(searchPath, cwd, { allowOutsideWorkspace: true });
        if (isSessionReadGranted(resolvedPath, cwd, context, { sessionAccess, nestedCompatibility })) {
          return false;
        }

        resolveWorkspacePath(searchPath, cwd);
        return false;
      } catch {
        return true;
      }
    },
    execute: async (params) => {
      const {
        pattern,
        path: searchPath,
        fixed_strings = false,
        ignore_case = false,
        include,
        exclude,
        no_ignore,
      } = params;

      // Validate pattern is not empty
      if (!pattern || pattern.trim() === '') {
        throw new Error('Search pattern cannot be empty. Please provide a valid search term.');
      }

      const max_results = 50; // Lowered to reduce output size

      const useRg = await checkRgAvailability(executionContext);
      let command = '';

      const limit = max_results;

      if (useRg) {
        const args = ['rg', '--line-number', '--no-heading', '--color=never'];
        if (ignore_case) args.push('--ignore-case');
        if (fixed_strings) args.push('--fixed-strings');
        if (!fixed_strings && patternMayMatchLineTerminator(pattern)) {
          args.push('--multiline');
        }
        if (no_ignore) args.push('--no-ignore');
        if (include) {
          const patterns = expandBraces(include);
          for (const pattern of patterns) {
            args.push('-g', shellQuoteArg(pattern));
          }
        }
        if (exclude) {
          const patterns = expandBraces(exclude);
          for (const pattern of patterns) {
            args.push('-g', shellQuoteArg(`!${pattern}`));
          }
        }

        // Shell-quote the pattern; do not regex-escape it.
        args.push('--', shellQuoteArg(pattern));

        args.push(shellQuoteSearchPath(searchPath, executionContext?.isRemote() ?? false));
        command = args.join(' ');
      } else {
        // Fallback to grep
        const args = ['grep', '-r', '-n', '-I']; // -I to ignore binary
        if (ignore_case) args.push('-i');
        if (fixed_strings) args.push('-F');
        if (include) {
          const patterns = expandBraces(include);
          for (const pattern of patterns) {
            args.push(`--include=${shellQuoteArg(pattern)}`);
          }
        }
        if (exclude) {
          const patterns = expandBraces(exclude);
          for (const pattern of patterns) {
            args.push(`--exclude=${shellQuoteArg(pattern)}`);
          }
        }

        // Shell-quote the pattern; do not regex-escape it.
        args.push('--', shellQuoteArg(pattern));

        args.push(shellQuoteSearchPath(searchPath, executionContext?.isRemote() ?? false));
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

      const filteredStdout = result.stdout;
      const trimmed = filteredStdout.trim();
      const lineCount = trimmed ? trimmed.split('\n').length : 0;
      const outputTrimmed = trimOutput(trimmed, limit);

      if (lineCount > limit) {
        return `${outputTrimmed}\n\nNote: ${lineCount} lines exceed the ${limit}-line limit. Narrow your search (pattern, path, or include).`;
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
  const fixed_strings = args?.fixed_strings ?? false;

  const parts = [`grep "${pattern}"`, `"${searchPath}"`];

  if (fixed_strings) {
    parts.push('--fixed-strings');
  }

  if (args?.ignore_case === true) {
    parts.push('--ignore-case');
  }
  if (args?.include) {
    parts.push(`--include "${args.include}"`);
  }
  if (args?.exclude) {
    parts.push(`--exclude "${args.exclude}"`);
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
