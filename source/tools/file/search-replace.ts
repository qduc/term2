import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { resolveWorkspacePath } from '../utils.js';
import type { ToolDefinition, CommandMessage, FormatCommandMessage } from '../types.js';
import type { ILoggingService, ISettingsService } from '../../services/service-interfaces.js';
import {
  getOutputText,
  safeJsonParse,
  normalizeToolArguments,
  createBaseMessage,
  pickPatchOutputItemText,
} from '../format-helpers.js';
import { healSearchReplaceParams } from './edit-healing.js';
import { ExecutionContext } from '../../services/execution-context.js';
import { getApprovalPresentationCapability } from '../tool-capabilities.js';
import { withFileLock } from './file-locks.js';
import {
  findMatchesInContent,
  normalizeSearchContent,
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
  search_content: z
    .string()
    .describe(
      'The exact content to search for. Put <...> on its own line to match (and replace) everything between a head anchor and a tail anchor — lets you edit or delete a large block without reproducing it. The whole span between anchors is replaced, so use distinctive multi-line anchors (never a single generic line) to avoid deleting the wrong region. Omit the anchors from replace_content to delete them too.',
    ),
  replace_content: z.string().describe('The content to replace it with'),
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

export type SearchReplaceOperation = z.input<typeof searchReplaceOperationSchema>;
export type SearchReplaceToolParams = z.input<typeof searchReplaceParametersSchema>;

export interface SearchReplaceFullOperation {
  path: string;
  search_content: string;
  replace_content: string;
  match_all?: boolean;
}

function getSearchReplaceOperations(params: SearchReplaceToolParams): SearchReplaceFullOperation[] {
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
  const parsedOutput = safeJsonParse(getOutputText(item));
  const replaceOutputItems = parsedOutput?.output ?? [];

  function getFormattedOperationArgs(item: any, replaceIndex = 0) {
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args = normalizeToolArguments(normalizedArgs) ?? {};
    const replaceResult = replaceOutputItems[replaceIndex];
    const filePath = args?.path ?? replaceResult?.path ?? 'unknown';
    const replacements = args?.replacements ?? [];
    const operationArgs = replacements[replaceIndex] ?? {};
    const searchContent = operationArgs?.search_content ?? '';
    const replaceContent = operationArgs?.replace_content ?? '';
    return { filePath, searchContent, replaceContent };
  }

  // If JSON parsing failed or no output array, create error message
  if (replaceOutputItems.length === 0) {
    const { filePath, searchContent, replaceContent } = getFormattedOperationArgs(item, 0);
    const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
    const output = getOutputText(item) || 'No output';
    const success = false;

    return [
      createBaseMessage(item, index, 0, false, {
        command,
        output,
        success,
        toolName: 'search_replace',
        toolArgs: {
          path: filePath,
          search_content: searchContent,
          replace_content: replaceContent,
        },
      }),
    ];
  }

  // Search replace tool can have multiple operation outputs
  const messages: CommandMessage[] = [];
  for (const [replaceIndex, replaceResult] of replaceOutputItems.entries()) {
    const { filePath, searchContent, replaceContent } = getFormattedOperationArgs(item, replaceIndex);

    const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
    const isHealed = replaceResult?.healed === true;
    let output = pickPatchOutputItemText(replaceResult) || 'No output';
    if (isHealed && !String(output).includes('healed')) {
      output = `${output} (healed)`;
    }
    const success = replaceResult?.success ?? false;

    messages.push(
      createBaseMessage(item, index, replaceIndex, false, {
        command,
        output,
        success,
        toolName: 'search_replace',
        toolArgs: {
          path: filePath,
          search_content: searchContent,
          replace_content: replaceContent,
        },
      }),
    );
  }
  return messages;
};

const SEARCH_REPLACE_DESCRIPTION =
  'Replace text in a file using layered, deterministic matching. Exact matching is preferred; conservative fallbacks tolerate line-ending, indentation, whitespace, escaped-text, and minor anchored multi-line differences. Matches must be unique unless match_all is true, and oversized fuzzy spans are rejected.\n' +
  'Gap matching: put <...> on its own line in search_content to match an unchanged region between a head anchor and a tail anchor. The entire span (both anchors plus everything between them) is what gets replaced, so a mis-placed anchor silently deletes a large region. Choose anchors that are distinctive and unambiguous — prefer a few lines of real, unique code; never anchor on a single generic line like "}", "return", or a blank line. Use this to edit or DELETE a large block without reproducing it. To delete the block including the anchors, omit them from replace_content; to delete only the middle, repeat the anchors in replace_content.\n' +
  'Use this tool for precise edits where you know the content to be replaced.';

export function createSearchReplaceToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  editHealing?: typeof healSearchReplaceParams;
}): ToolDefinition<SearchReplaceToolParams> {
  const { loggingService, settingsService, executionContext, editHealing = healSearchReplaceParams } = deps;
  const editCache = new SearchReplaceEditCache();

  return {
    name: 'search_replace',
    description: SEARCH_REPLACE_DESCRIPTION,
    parameters: searchReplaceParametersSchema,
    approvalPresentation: getApprovalPresentationCapability('search_replace'),
    needsApproval: async (params) => {
      try {
        const operations = getSearchReplaceOperations(params);
        const cwd = executionContext?.getCwd() || process.cwd();
        if (operations.length > 1) {
          const allInsideCwd = operations.every((operation) => {
            try {
              const targetPath = resolveWorkspacePath(operation.path, cwd);
              return targetPath.startsWith(cwd + path.sep);
            } catch {
              return false;
            }
          });
          return !allInsideCwd;
        }

        const operation = operations[0];
        const { path: filePath, search_content, replace_content } = operation;
        const targetPath = resolveWorkspacePath(filePath, cwd);
        const workspaceRoot = cwd;
        const insideCwd = targetPath.startsWith(workspaceRoot + path.sep);

        const sshService = executionContext?.getSSHService();
        const isRemote = executionContext?.isRemote() && !!sshService;

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
    execute: async (params) => {
      const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
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

      const applyToContent = async (operation: SearchReplaceFullOperation, content: string) => {
        const { path: filePath, search_content, replace_content, match_all } = operation;

        if (search_content === '') {
          return fail(
            'search_content must not be empty when editing an existing file. Provide search text or create a new file with an empty search.',
          );
        }

        if (search_content === replace_content) {
          return fail('search_content and replace_content are identical.');
        }

        const markerError = detectSummarizationMarkers(search_content);
        if (markerError) {
          return fail(markerError);
        }

        let usedHealing = false;
        let healingAttempted = false;
        let healingSucceeded = false;
        let healedSearchLength = 0;
        let matchTypeAfterHealing: MatchInfo['type'] = 'none';
        let healingFailureReason: string | undefined;

        let { eol, normalizedSearchContent, matchInfo } = prepareMatchContext(operation, content, editCache);

        if (matchInfo.type === 'none') {
          if (containsGapMarker(search_content)) {
            return fail(
              (matchInfo.diagnostic ?? 'Gap pattern did not match. Recheck the head and tail anchor lines.') +
                ' Gap (<...>) edits are not auto-healed — fix the anchors and retry.',
            );
          }
          const enableEditHealing = settingsService.get<boolean>('tools.enableEditHealing') ?? true;
          if (enableEditHealing) {
            healingAttempted = true;
            const healingModel = settingsService.get<string>('tools.editHealingModel') ?? 'gpt-4o-mini';
            const healingResult = await editHealing(
              operation,
              content,
              healingModel,
              process.env.OPENAI_API_KEY ?? '',
              {
                settingsService,
                loggingService,
              },
            );

            healedSearchLength = healingResult.params.search_content.length;
            healingFailureReason = healingResult.failureReason;

            if (healingResult.wasModified) {
              normalizedSearchContent = normalizeSearchContent(healingResult.params.search_content, filePath, eol);
              matchInfo = findMatchesInContent(content, normalizedSearchContent);
              matchTypeAfterHealing = matchInfo.type;
              if (matchInfo.type !== 'none') {
                usedHealing = true;
                healingSucceeded = true;
              }
            }

            if (enableFileLogging) {
              loggingService.debug('search_replace healing attempt', {
                path: filePath,
                healing_attempted: healingAttempted,
                healing_succeeded: healingSucceeded,
                original_search_length: search_content.length,
                healed_search_length: healedSearchLength,
                match_type_after_healing: matchTypeAfterHealing,
                failure_reason: healingFailureReason,
              });
            }

            if (!usedHealing) {
              const reasonSuffix = healingFailureReason ? ` Reason: ${healingFailureReason}.` : '';
              return fail(
                `Search content not found. Auto-healing attempted but no match found.${reasonSuffix} Try splitting changes into smaller patterns.`,
                { healing_failure_reason: healingFailureReason },
              );
            }
          }
        }

        const replacementResult = executeReplacement(matchInfo, content, eol, {
          replaceContent: replace_content,
          matchAll: match_all ?? false,
        });

        if (!replacementResult.success) {
          return fail(replacementResult.error);
        }

        if (enableFileLogging) {
          loggingService.debug(`File updated (${replacementResult.matchType} match)`, {
            path: filePath,
            count: replacementResult.replacedCount,
            healed: usedHealing,
          });
        }

        const successMessage = usedHealing
          ? `Updated ${filePath} (Search param has minor difference with actual file, auto healing was used. Reread the file to make sure the edit is correct)`
          : `Updated ${filePath} (${replacementResult.replacedCount} ${replacementResult.matchType} match${
              replacementResult.replacedCount > 1 ? 'es' : ''
            })`;
        return {
          newContent: replacementResult.newContent,
          output: {
            success: true,
            operation: 'search_replace',
            path: filePath,
            message: successMessage,
            healed: usedHealing,
          },
        };
      };

      try {
        const operations = getSearchReplaceOperations(params);
        const indexedOperations = operations.map((operation, index) => ({
          operation,
          index,
          targetPath: resolveWorkspacePath(operation.path, cwd),
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

              const result = await applyToContent(operation, nextContent);
              output[index] = result.output;
              if (!result.output.success) {
                continue;
              }
              nextContent = (result as { newContent: string }).newContent;
              changed = true;
            }

            if (changed) {
              await writeFileFn(targetPath, nextContent);
            }
          });
        }

        return JSON.stringify({
          output: output.filter(Boolean),
        });
      } catch (error: any) {
        if (enableFileLogging) {
          loggingService.error('File operation failed', {
            type: 'search_replace',
            path: params.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return JSON.stringify({
          output: [
            {
              success: false,
              error: error.message || String(error),
            },
          ],
        });
      }
    },
    formatCommandMessage: formatSearchReplaceCommandMessage,
  };
}
