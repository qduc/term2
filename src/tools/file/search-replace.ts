import { z } from 'zod';
import { normalizeObjectParams } from '../tool-invoke.js';
import {
  abortFailedGroup,
  labelFailure,
  normalizeSearchReplaceShape,
  readSearchReplaceArguments,
  renderBatchResult,
  skippedNoOp,
  type BatchEntry,
} from './search-replace-protocol.js';
import { describeSearchMismatch } from './closest-line.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { isProtectedHookPath, isWorkspacePathPhysicallyInside, resolveWorkspacePath } from '../utils.js';
import { SANDBOX_TEMP_DIR } from '../../shared/utils/shell/temp-dir.js';
import type { ScriptedToolDefinition, FormatCommandMessage } from '../types.js';
import type { ILoggingService, ISettingsService } from '../../shared/service-interfaces.js';
import type { FileEditAccessPort } from '../access-port.js';
import {
  getOutputText,
  isSuccessOutput,
  safeJsonParse,
  normalizeToolArguments,
  createBaseMessage,
  formatPatchOutputItems,
} from '../format-helpers.js';
import { ExecutionContext } from '../execution-context.js';
import { getApprovalPresentationCapability } from '../tool-capabilities.js';
import { withFileLock } from './file-locks.js';
import {
  normalizeToEOL,
  prepareMatchContext,
  SearchReplaceEditCache,
  type MatchInfo,
} from './search-replace-matcher.js';

/**
 * Detect summarization markers in content that indicate truncated/omitted code.
 */
function detectSummarizationMarkers(content: string): string | null {
  if (/Lines \d+-\d+ omitted/i.test(content)) {
    return 'oldString contains "Lines X-Y omitted" marker - provide the actual content';
  }
  if (content.includes('{…}') || content.includes('{...}')) {
    return 'oldString contains ellipsis marker {…} - provide the actual content';
  }
  if (content.includes('/*...*/') || content.includes('/* ... */')) {
    return 'oldString contains /*...*/ marker - provide the actual content';
  }
  if (content.includes('// ...') || content.includes('//...')) {
    return 'oldString contains // ... marker - provide the actual content';
  }
  if (content.includes('# ...') || content.includes('#...')) {
    return 'oldString contains # ... marker - provide the actual content';
  }
  return null;
}

const searchReplaceOperationSchema = z.object({
  search_content: z.string().describe('The exact content to search for. <...> on its own line acts as a gap anchor.'),
  replace_content: z.string().describe('The content to replace the matched search_content with.'),
  match_all: z
    .boolean()
    .optional()
    .default(false)
    .describe('Replace every non-overlapping match. Defaults to false, which requires exactly one match.'),
});

const searchReplaceParametersSchema = z.object({
  path: z.string().describe('The absolute or relative path to the file'),
  replacements: z.array(searchReplaceOperationSchema).min(1).describe('The list of replacements to apply to the file'),
});

/**
 * Execution-side schema: reads the flat single-edit form as one replacement. The provider is shown
 * `searchReplaceParametersSchema` (the tool's `parameters`) unchanged; this wraps it as a plain preprocess.
 */
const searchReplaceCanonicalSchema = z.preprocess((raw, ctx) => {
  const shaped = normalizeSearchReplaceShape(normalizeObjectParams(raw, searchReplaceParametersSchema));
  if (!shaped.ok) {
    ctx.addIssue({ code: 'custom', message: shaped.message });
    return raw;
  }
  return shaped.value;
}, searchReplaceParametersSchema);

export type SearchReplaceOperation = z.infer<typeof searchReplaceOperationSchema>;
export type SearchReplaceToolParams = z.infer<typeof searchReplaceParametersSchema>;

export interface SearchReplaceFullOperation {
  path: string;
  search_content: string;
  replace_content: string;
  match_all?: boolean;
}

function getSearchReplaceOperations(rawParams: SearchReplaceToolParams): SearchReplaceFullOperation[] {
  const params = readSearchReplaceArguments(rawParams) as SearchReplaceToolParams;
  return params.replacements.map((rep) => ({
    path: params.path,
    search_content: rep.search_content,
    replace_content: rep.replace_content,
    match_all: rep.match_all ?? false,
  }));
}

function containsGapMarker(content: string): boolean {
  return content.includes('<...>');
}

function evaluateApprovalForMatch(
  matchInfo: MatchInfo,
  matchAll: boolean,
  insideCwd: boolean,
  filePath: string,
  loggingService: ILoggingService,
): boolean {
  if (matchInfo.type === 'none') {
    loggingService.warn('search_replace validation: no match found - will fail in execute', {
      path: filePath,
    });
    return false;
  }

  if (matchInfo.count > 1 && !matchAll) {
    loggingService.warn(`search_replace validation: multiple ${matchInfo.type} matches - will fail in execute`, {
      path: filePath,
      count: matchInfo.count,
    });
    return false;
  }

  if (matchInfo.type === 'exact') {
    loggingService.debug('search_replace validation: exact match found', {
      path: filePath,
      count: matchInfo.count,
    });
    return insideCwd ? false : true;
  }

  if (matchInfo.type === 'gap') {
    loggingService.debug('search_replace validation: gap match found', {
      path: filePath,
      count: matchInfo.count,
    });
    return insideCwd ? false : true;
  }

  if (matchInfo.type === 'relaxed') {
    loggingService.debug('search_replace validation: relaxed match found', {
      path: filePath,
      count: matchInfo.count,
    });
    return insideCwd ? false : true;
  }

  if (matchInfo.type === 'normalized') {
    loggingService.debug('search_replace validation: normalized match found', {
      path: filePath,
      count: matchInfo.count,
    });
    return insideCwd ? false : true;
  }

  loggingService.debug(`search_replace validation: ${matchInfo.type} match found`, {
    path: filePath,
    count: matchInfo.count,
  });
  return insideCwd ? false : true;
}

interface ReplacementExecutionSuccess {
  success: true;
  newContent: string;
  matchType: Exclude<MatchInfo['type'], 'none'>;
  replacedCount: number;
}

interface ReplacementExecutionFailure {
  success: false;
  error: string;
}

type ReplacementExecutionResult = ReplacementExecutionSuccess | ReplacementExecutionFailure;

function replaceIndexedMatches(
  content: string,
  matches: { startIndex: number; endIndex: number }[],
  replaceContent: string,
  matchAll: boolean,
): { newContent: string; replacedCount: number } {
  const selectedMatches = matchAll ? selectNonOverlappingMatches(matches) : matches.slice(0, 1);
  let newContent = content;
  for (const match of [...selectedMatches].reverse()) {
    newContent = newContent.substring(0, match.startIndex) + replaceContent + newContent.substring(match.endIndex);
  }
  return {
    newContent,
    replacedCount: selectedMatches.length,
  };
}

function selectNonOverlappingMatches(
  matches: { startIndex: number; endIndex: number }[],
): { startIndex: number; endIndex: number }[] {
  const selected: { startIndex: number; endIndex: number }[] = [];
  let previousEnd = -1;
  for (const match of matches) {
    if (match.startIndex < previousEnd) continue;
    selected.push(match);
    previousEnd = match.endIndex;
  }
  return selected;
}

function executeReplacement(
  matchInfo: MatchInfo,
  content: string,
  eol: string,
  options: {
    replaceContent: string;
    matchAll: boolean;
  },
): ReplacementExecutionResult {
  const normalizedReplaceContent = normalizeToEOL(options.replaceContent, eol);

  if (matchInfo.type === 'none') {
    return {
      success: false,
      error: 'Search content not found. Try splitting the changes into smaller search pattern.',
    };
  }

  if (matchInfo.count > 1 && !options.matchAll) {
    return {
      success: false,
      error: `Found ${matchInfo.count} ${matchInfo.type} matches. Search content must match exactly once. Set match_all to true to replace all matches.`,
    };
  }

  const replaced = replaceIndexedMatches(content, matchInfo.matches, normalizedReplaceContent, options.matchAll);
  return {
    success: true,
    newContent: replaced.newContent,
    matchType: matchInfo.type,
    replacedCount: replaced.replacedCount,
  };
}

export const formatSearchReplaceCommandMessage: FormatCommandMessage = (item, index, _toolCallArgumentsById) => {
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = (readSearchReplaceArguments(normalizeToolArguments(normalizedArgs) ?? {}) as Record<string, any>) ?? {};
  const replacements = Array.isArray(args?.replacements) ? args.replacements : [];
  const firstReplacement = replacements[0] ?? {};
  const filePath = args?.path ?? 'unknown';
  const searchContent = firstReplacement.search_content ?? '';
  const replaceContent = firstReplacement.replace_content ?? '';

  const rawOutput = getOutputText(item) || 'No output';
  // Backward compatibility: old outputs were JSON strings with an output array.
  const parsedOutput = rawOutput.startsWith('{') ? safeJsonParse(rawOutput) : undefined;
  let output: string;
  if (Array.isArray(parsedOutput?.output) && parsedOutput.output.length > 0) {
    output = formatPatchOutputItems(parsedOutput.output) || rawOutput;
  } else {
    output = rawOutput;
  }
  const success = isSuccessOutput(output);

  return [
    createBaseMessage(item, index, 0, false, {
      command: `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"${
        replacements.length > 1 ? ` (${replacements.length} edits)` : ''
      }`,
      output,
      success,
      toolName: 'search_replace',
      toolArgs: {
        path: filePath,
        replacements,
      },
    }),
  ];
};

const SEARCH_REPLACE_DESCRIPTION =
  'Replace text in a file using layered, deterministic matching. Exact matching is preferred; conservative fallbacks tolerate line-ending, indentation, whitespace, escaped-text, and minor anchored multi-line differences. Matches must be unique unless match_all is true, and oversized fuzzy spans are rejected.\n' +
  'Gap matching: When rewriting large chunks of text, put <...> on its own line in search_content to match an unchanged region between a head anchor and a tail anchor. The entire span—both anchors and everything between them—is replaced, so a misplaced anchor silently deletes a large region. Choose distinctive, unambiguous anchors: prefer a few lines of real, unique code. Never anchor on a single generic line like }, return, or a blank line. Use this to edit or delete a large block without reproducing it: Delete the block including anchors: omit them from replace_content. Delete only the middle: repeat the anchors in replace_content.\n' +
  'Do NOT use this to create files from scratch; inside run_code, use tools.create_file(...). Returns a plain-text summary with one line per replacement: Updated <path> or Error: <reason>.';

export function createSearchReplaceToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  sessionAccess?: FileEditAccessPort;
  /**
   * Whether the caller may also read this file. The nearest-line hint echoes file content, so it is given
   * only when this says yes (same authority as read_file); absent means never.
   */
  readAccess?: (absolutePath: string, context: unknown) => Promise<boolean>;
}): ScriptedToolDefinition<typeof searchReplaceParametersSchema> {
  const { loggingService, settingsService, executionContext, sessionAccess } = deps;
  const editCache = new SearchReplaceEditCache();

  return {
    name: 'search_replace',
    description: SEARCH_REPLACE_DESCRIPTION,
    scriptedReturnShape:
      'string: one status line per operation, newline-joined — "Updated <path> (N match)" | "Created <path> (new file)" | "Error: \u2026"',
    effect: 'mutating',
    canRequireApproval: true,
    scriptedReturnSchema: z.string(),
    parameters: searchReplaceParametersSchema,
    canonicalParameters: searchReplaceCanonicalSchema,
    approvalPresentation: getApprovalPresentationCapability('search_replace'),
    needsApproval: async (params) => {
      if (sessionAccess?.isReadOnly) return false;
      if (settingsService.get('shell.autoApproveMode') === 'always') {
        loggingService.security('search_replace needsApproval: auto-approved in YOLO mode', {
          operationCount: getSearchReplaceOperations(params).length,
        });
        return false;
      }
      try {
        const operations = getSearchReplaceOperations(params);
        const cwd = executionContext?.getCwd() || process.cwd();
        const sshService = executionContext?.getSSHService();
        const isRemote = executionContext?.isRemote() && !!sshService;
        const resolvedOperations: Array<SearchReplaceFullOperation & { targetPath: string; insideCwd: boolean }> = [];

        // Check every batch target physically before reading any file. This
        // prevents validation from following an in-workspace symlink outside
        // the workspace before approval is requested.
        for (const operation of operations) {
          let targetPath: string;
          try {
            targetPath = resolveWorkspacePath(operation.path, cwd);
          } catch {
            return true;
          }

          const insideCwd =
            targetPath.startsWith(cwd + path.sep) ||
            targetPath === SANDBOX_TEMP_DIR ||
            targetPath.startsWith(SANDBOX_TEMP_DIR + path.sep);
          const physicallyInsideWorkspace =
            !isRemote &&
            insideCwd &&
            !isProtectedHookPath(targetPath, cwd) &&
            ((await isWorkspacePathPhysicallyInside(targetPath, cwd)) ||
              (await isWorkspacePathPhysicallyInside(targetPath, SANDBOX_TEMP_DIR)));
          if (!physicallyInsideWorkspace) {
            if (!sessionAccess?.allowsEdit(targetPath, cwd)) return true;
          }

          resolvedOperations.push({ ...operation, targetPath, insideCwd });
        }

        // Preserve the existing batch behavior: boundary checks are applied to
        // all operations, while content validation remains single-operation.
        if (operations.length > 1) {
          return false;
        }

        const operation = resolvedOperations[0];
        const { path: filePath, search_content, replace_content, targetPath, insideCwd } = operation;

        // Read file content
        let content: string;
        try {
          if (isRemote && sshService) {
            content = await sshService.readFile(targetPath);
          } else {
            content = await readFile(targetPath, 'utf8');
          }
        } catch (error: any) {
          if (search_content === '' && error?.code === 'ENOENT') {
            loggingService.debug('search_replace validation: creating new file because search_content is empty', {
              path: filePath,
            });
            if (insideCwd) {
              return false;
            }
            return true;
          }
          loggingService.error('search_replace needsApproval: file not found', {
            path: filePath,
            error: error?.message || String(error),
          });
          return true;
        }

        if (search_content === '') {
          loggingService.warn('search_replace validation: empty search_content on existing file', {
            path: filePath,
          });
          return true;
        }

        if (search_content === replace_content) {
          loggingService.warn('search_replace validation: search_content and replace_content are identical', {
            path: filePath,
          });
          // Auto-approve - execute will handle the error gracefully
          return false;
        }

        // Check for summarization markers
        const markerError = detectSummarizationMarkers(search_content);
        if (markerError) {
          loggingService.warn('search_replace validation: summarization marker detected', {
            path: filePath,
            error: markerError,
          });
          // Auto-approve - execute will handle the error gracefully
          return false;
        }

        // Detect EOL, normalize search content, find matches, and cache result
        const { matchInfo } = prepareMatchContext(operation, content, editCache);

        return evaluateApprovalForMatch(matchInfo, operation.match_all ?? false, insideCwd, filePath, loggingService);
      } catch (error: any) {
        loggingService.error('search_replace needsApproval error', {
          error: error?.message || String(error),
        });
        return true;
      }
    },
    execute: async (params, context) => {
      if (sessionAccess?.isReadOnly) return 'Error: search_replace is unavailable in a read-only session.';
      const enableFileLogging = settingsService.get('tools.logFileOperations');
      const cwd = executionContext?.getCwd() || process.cwd();
      const sshService = executionContext?.getSSHService();
      const isRemote = executionContext?.isRemote() && !!sshService;

      const readFileFn = async (p: string) => {
        if (isRemote && sshService) return sshService.readFile(p);
        return readFile(p, 'utf8');
      };

      const writeFileFn = async (p: string, c: string) => {
        if (isRemote && sshService) return sshService.writeFile(p, c);
        return writeFile(p, c, 'utf8');
      };

      const fail = (error: string, extra?: Record<string, unknown>) => ({
        output: { success: false, error, ...extra },
      });

      const applyToContent = async (
        operation: SearchReplaceFullOperation,
        content: string,
        mayHint: () => Promise<boolean>,
      ) => {
        const { path: filePath, search_content, replace_content, match_all } = operation;

        if (search_content === '') {
          return fail(
            'search_content must not be empty when editing an existing file. Provide search text or create a new file with an empty search.',
          );
        }

        if (search_content === replace_content) {
          return fail(
            'search_content and replace_content are identical, so there is nothing to change. Send a different replace_content, or leave this edit out.',
          );
        }

        const markerError = detectSummarizationMarkers(search_content);
        if (markerError) {
          return fail(markerError);
        }

        const { eol, matchInfo } = prepareMatchContext(operation, content, editCache);

        if (matchInfo.type === 'none' && containsGapMarker(search_content)) {
          return fail(
            (matchInfo.diagnostic ?? 'Gap pattern did not match. Recheck the head and tail anchor lines.') +
              ' Gap (<...>) edits are not auto-healed — fix the anchors and retry.',
          );
        }

        const replacementResult = executeReplacement(matchInfo, content, eol, {
          replaceContent: replace_content,
          matchAll: match_all ?? false,
        });

        if (!replacementResult.success) {
          const hint =
            matchInfo.type === 'none' && (await mayHint()) ? describeSearchMismatch(search_content, content) : '';
          return fail(hint ? `${replacementResult.error} ${hint}` : replacementResult.error);
        }

        if (enableFileLogging) {
          loggingService.debug(`File updated (${replacementResult.matchType} match)`, {
            path: filePath,
            count: replacementResult.replacedCount,
          });
        }

        const successMessage = `Updated ${filePath} (${replacementResult.replacedCount} ${
          replacementResult.matchType
        } match${replacementResult.replacedCount > 1 ? 'es' : ''})`;
        return {
          newContent: replacementResult.newContent,
          output: {
            success: true,
            operation: 'search_replace',
            path: filePath,
            message: successMessage,
          },
        };
      };

      try {
        const operations = getSearchReplaceOperations(params);
        const indexedOperations = operations.map((operation, index) => ({
          operation,
          index,
          // Standard modes enforce the workspace boundary in `needsApproval`;
          // YOLO deliberately reaches execute without a permission prompt.
          targetPath: resolveWorkspacePath(operation.path, cwd, { allowOutsideWorkspace: true }),
        }));
        const groups = new Map<string, typeof indexedOperations>();
        for (const indexedOperation of indexedOperations) {
          groups.set(indexedOperation.targetPath, [
            ...(groups.get(indexedOperation.targetPath) ?? []),
            indexedOperation,
          ]);
        }

        const output: Array<Record<string, unknown>> = new Array(operations.length);

        for (const [targetPath, group] of groups) {
          await withFileLock(targetPath, async () => {
            let content = '';
            let fileExists = true;

            try {
              content = await readFileFn(targetPath);
            } catch (error: any) {
              if (error?.code === 'ENOENT') {
                fileExists = false;
              } else {
                throw error;
              }
            }

            if (enableFileLogging) {
              loggingService.debug(`File operation started: search_replace`, {
                path: group[0].operation.path,
                targetPath,
                operationCount: group.length,
              });
            }

            let nextContent = content;
            let changed = false;
            let hintDecision: Promise<boolean> | undefined;
            const mayHint = () =>
              (hintDecision ??= deps.readAccess ? deps.readAccess(targetPath, context) : Promise.resolve(false));

            for (const { operation, index } of group) {
              if (!fileExists) {
                if (operation.search_content === '') {
                  nextContent = operation.replace_content;
                  fileExists = true;
                  changed = true;
                  output[index] = {
                    success: true,
                    operation: 'search_replace',
                    path: operation.path,
                    message: `Created ${operation.path} (new file)`,
                  };
                  continue;
                }

                output[index] = {
                  success: false,
                  error: `File not found: ${operation.path}`,
                };
                continue;
              }

              // A no-op pair inside a batch is skipped and reported, so one redundant pair does not discard
              // the others. A lone no-op call stays an error (applyToContent): it is the whole call's mistake.
              if (
                operations.length > 1 &&
                operation.search_content !== '' &&
                operation.search_content === operation.replace_content
              ) {
                output[index] = skippedNoOp(index, nextContent.includes(operation.search_content));
                continue;
              }

              const result = await applyToContent(operation, nextContent, mayHint);
              output[index] = result.output;
              if (!result.output.success) {
                output[index] = labelFailure(result.output as BatchEntry, index, operations.length);
                continue;
              }
              nextContent = (result as { newContent: string }).newContent;
              changed = true;
            }

            if (abortFailedGroup(group, output as BatchEntry[], operations.length)) {
              // Nothing is written when any replacement failed.
            } else if (changed) {
              await writeFileFn(targetPath, nextContent);
            }
          });
        }

        return renderBatchResult(output as BatchEntry[], params.path);
      } catch (error: any) {
        if (enableFileLogging) {
          loggingService.error('File operation failed', {
            type: 'search_replace',
            path: params.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return `Error: ${(error.message || String(error)).replace(/\n/g, ' ')}`;
      }
    },
    formatCommandMessage: formatSearchReplaceCommandMessage,
  };
}
