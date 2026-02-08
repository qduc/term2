import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { resolveWorkspacePath } from './utils.js';
import type { ToolDefinition, CommandMessage } from './types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { getOutputText, safeJsonParse, normalizeToolArguments, createBaseMessage } from './format-helpers.js';
import { healSearchReplaceParams } from './edit-healing.js';
import { ExecutionContext } from '../services/execution-context.js';

/**
 * Detect the predominant EOL style in file content.
 * Returns '\r\n' if CRLF is dominant, otherwise '\n'.
 */
function detectEOL(content: string): string {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

/**
 * Normalize line endings in search/replace content to match the target file's EOL style.
 */
function normalizeToEOL(content: string, eol: string): string {
  // First normalize to LF, then convert to target EOL
  return content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

/**
 * Remove leading filepath comments that models often add to code blocks.
 * E.g., "// src/file.ts" or "# path/to/file.py" at the start.
 */
function removeLeadingFilepathComment(content: string, filePath: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return content;

  const firstLine = lines[0].trim();
  const basename = path.basename(filePath);

  // Check for common comment patterns with filepath
  const patterns = [
    /^\/\/\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*$/, // // path/to/file.ext
    /^#\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*$/, // # path/to/file.ext
    /^\/\*\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*\*\/\s*$/, // /* path/to/file.ext */
    /^<!--\s*.*[\\/]?[\w.-]+\.[a-zA-Z]+\s*-->\s*$/, // <!-- path/to/file.ext -->
  ];

  // Check if first line matches a filepath comment pattern and contains the basename
  const isFilepathComment = patterns.some((p) => p.test(firstLine)) && firstLine.includes(basename);

  if (isFilepathComment) {
    return lines.slice(1).join('\n');
  }

  return content;
}

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

const searchReplaceParametersSchema = z.object({
  path: z.string().describe('The absolute or relative path to the file'),
  search_content: z.string().describe('The exact content to search for'),
  replace_content: z.string().describe('The content to replace it with'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Whether to replace all occurrences of the search content. If false, requires exactly one match.'),
});

export type SearchReplaceToolParams = z.infer<typeof searchReplaceParametersSchema>;

/**
 * Information about exact matches found in content
 */
interface ExactMatchInfo {
  type: 'exact';
  count: number;
}

/**
 * Information about relaxed matches found in content (with position details)
 */
interface RelaxedMatchInfo {
  type: 'relaxed';
  count: number;
  matches: { startIndex: number; endIndex: number }[];
}

/**
 * Information about whitespace-normalized matches found in content
 */
interface NormalizedMatchInfo {
  type: 'normalized';
  count: number;
  matches: { startIndex: number; endIndex: number }[];
}

/**
 * Information indicating no matches were found
 */
interface NoMatchInfo {
  type: 'none';
}

type MatchInfo = ExactMatchInfo | RelaxedMatchInfo | NormalizedMatchInfo | NoMatchInfo;

/**
 * Cache for edit preparation to avoid redundant work.
 */
interface EditCache {
  key: string;
  matchInfo: MatchInfo;
  content: string;
  eol: string;
}

let lastEditCache: EditCache | null = null;

function getEditCacheKey(params: SearchReplaceToolParams): string {
  return JSON.stringify({
    path: params.path,
    search_content: params.search_content,
    replace_content: params.replace_content,
    replace_all: params.replace_all,
  });
}

/**
 * Parse file content into lines with position information
 */
function parseFileLines(content: string): { text: string; trimmed: string; start: number; end: number }[] {
  const lineInfos: {
    text: string;
    trimmed: string;
    start: number;
    end: number;
  }[] = [];
  const regex = /([^\r\n]*)(\r?\n|$)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
    const fullMatch = match[0];
    if (fullMatch.length === 0 && match.index >= content.length) break;

    const lineContent = match[1];
    lineInfos.push({
      text: lineContent,
      trimmed: lineContent.trim(),
      start: match.index,
      end: match.index + fullMatch.length,
    });

    if (match.index + fullMatch.length === content.length) break;
  }
  return lineInfos;
}

/**
 * Normalize whitespace by collapsing any whitespace run to a single space.
 * Returns the normalized text and a map from normalized indices to original indices.
 */
function normalizeWhitespaceWithMap(content: string): {
  normalized: string;
  indexMap: number[];
} {
  let normalized = '';
  const indexMap: number[] = [];
  let inWhitespace = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (/\s/.test(char)) {
      if (!inWhitespace && normalized.length > 0) {
        normalized += ' ';
        indexMap.push(i);
      }
      inWhitespace = true;
      continue;
    }
    inWhitespace = false;
    normalized += char;
    indexMap.push(i);
  }

  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    indexMap.pop();
  }

  return { normalized, indexMap };
}

function normalizeWhitespace(content: string): string {
  return normalizeWhitespaceWithMap(content).normalized;
}

/**
 * Find matches in content using exact matching first, then relaxed matching.
 * Returns detailed match information including positions for replacement.
 */
function findMatchesInContent(content: string, searchContent: string): MatchInfo {
  // 1. Try exact match first
  let matchCount = 0;
  let index = content.indexOf(searchContent);
  while (index !== -1) {
    matchCount++;
    index = content.indexOf(searchContent, index + 1);
  }

  if (matchCount > 0) {
    return { type: 'exact', count: matchCount };
  }

  // 2. Try relaxed match (whitespace-insensitive line matching)
  const searchLines = searchContent.split(/\r?\n/).map((l) => l.trim());
  const lineInfos = parseFileLines(content);

  const matches: { startIndex: number; endIndex: number }[] = [];
  for (let i = 0; i <= lineInfos.length - searchLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (lineInfos[i + j].trimmed !== searchLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matches.push({
        startIndex: lineInfos[i].start,
        endIndex: lineInfos[i + searchLines.length - 1].end,
      });
    }
  }

  if (matches.length > 0) {
    return { type: 'relaxed', count: matches.length, matches };
  }

  // 3. Try normalized whitespace match (collapse whitespace differences)
  const normalizedSearch = normalizeWhitespace(searchContent);
  if (normalizedSearch.length > 0) {
    const { normalized: normalizedContent, indexMap } = normalizeWhitespaceWithMap(content);
    const normalizedMatches: { startIndex: number; endIndex: number }[] = [];
    let normalizedIndex = normalizedContent.indexOf(normalizedSearch);
    while (normalizedIndex !== -1) {
      const beforeIndex = normalizedIndex - 1;
      const afterIndex = normalizedIndex + normalizedSearch.length;
      const beforeChar = beforeIndex >= 0 ? normalizedContent[beforeIndex] : '';
      const afterChar = afterIndex < normalizedContent.length ? normalizedContent[afterIndex] : '';
      const hasLeadingBoundary = beforeIndex < 0 || beforeChar === ' ';
      const hasTrailingBoundary = afterIndex >= normalizedContent.length || afterChar === ' ';

      if (!hasLeadingBoundary || !hasTrailingBoundary) {
        normalizedIndex = normalizedContent.indexOf(normalizedSearch, normalizedIndex + 1);
        continue;
      }

      const startIndex = indexMap[normalizedIndex];
      const endIndex = indexMap[normalizedIndex + normalizedSearch.length - 1] + 1;
      normalizedMatches.push({ startIndex, endIndex });
      normalizedIndex = normalizedContent.indexOf(normalizedSearch, normalizedIndex + 1);
    }

    if (normalizedMatches.length > 0) {
      return {
        type: 'normalized',
        count: normalizedMatches.length,
        matches: normalizedMatches,
      };
    }
  }

  return { type: 'none' };
}

export const formatSearchReplaceCommandMessage = (
  item: any,
  index: number,
  _toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const parsedOutput = safeJsonParse(getOutputText(item));
  const replaceOutputItems = parsedOutput?.output ?? [];

  // If JSON parsing failed or no output array, create error message
  if (replaceOutputItems.length === 0) {
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args = normalizeToolArguments(normalizedArgs) ?? {};
    const filePath = args?.path ?? 'unknown';
    const searchContent = args?.search_content ?? '';
    const replaceContent = args?.replace_content ?? '';
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
          replace_all: args?.replace_all ?? false,
        },
      }),
    ];
  }

  // Search replace tool can have multiple operation outputs
  const messages: CommandMessage[] = [];
  for (const [replaceIndex, replaceResult] of replaceOutputItems.entries()) {
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args = normalizeToolArguments(normalizedArgs) ?? {};
    const filePath = args?.path ?? replaceResult?.path ?? 'unknown';
    const searchContent = args?.search_content ?? '';
    const replaceContent = args?.replace_content ?? '';

    const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
    const isHealed = replaceResult?.healed === true;
    let output = replaceResult?.message ?? replaceResult?.error ?? 'No output';
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
          replace_all: args?.replace_all ?? false,
        },
      }),
    );
  }
  return messages;
};

export function createSearchReplaceToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  editHealing?: typeof healSearchReplaceParams;
}): ToolDefinition<SearchReplaceToolParams> {
  const { loggingService, settingsService, executionContext, editHealing = healSearchReplaceParams } = deps;

  return {
    name: 'search_replace',
    description:
      'Replace text in a file using exact or relaxed matching.\n' +
      'Set replace_all to true to replace all occurrences instead of requiring a unique match.\n' +
      'Use this tool for precise edits where you know the content to be replaced.',
    parameters: searchReplaceParametersSchema,
    needsApproval: async (params) => {
      try {
        const editMode = settingsService.get<boolean>('app.editMode');
        const { path: filePath, search_content, replace_all = false } = params;
        const cwd = executionContext?.getCwd() || process.cwd();
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
            loggingService.info('search_replace validation: creating new file because search_content is empty', {
              path: filePath,
            });
            if (editMode && insideCwd) {
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

        // Detect EOL and normalize search content
        const eol = detectEOL(content);
        const normalizedSearchContent = normalizeToEOL(removeLeadingFilepathComment(search_content, filePath), eol);

        // Find matches using shared logic with normalized content
        const matchInfo = findMatchesInContent(content, normalizedSearchContent);

        // Cache the result for execute phase
        lastEditCache = {
          key: getEditCacheKey(params),
          matchInfo,
          content,
          eol,
        };

        if (matchInfo.type === 'exact') {
          if (!replace_all && matchInfo.count > 1) {
            loggingService.warn('search_replace validation: multiple exact matches, replace_all=false', {
              path: filePath,
              count: matchInfo.count,
            });
            return true;
          }
          loggingService.info('search_replace validation: exact match(es) found', {
            path: filePath,
            count: matchInfo.count,
            replace_all,
          });
          if (editMode && insideCwd) {
            return false;
          }
          return true;
        }

        if (matchInfo.type === 'relaxed') {
          if (!replace_all && matchInfo.count > 1) {
            loggingService.warn(
              'search_replace validation: multiple relaxed matches, replace_all=false - will fail in execute',
              {
                path: filePath,
                count: matchInfo.count,
              },
            );
            // Auto-approve - execute will handle the error gracefully
            return false;
          }
          loggingService.info('search_replace validation: relaxed match(es) found', {
            path: filePath,
            count: matchInfo.count,
            replace_all,
          });
          return true;
        }

        if (matchInfo.type === 'normalized') {
          if (!replace_all && matchInfo.count > 1) {
            loggingService.warn(
              'search_replace validation: multiple normalized matches, replace_all=false - will fail in execute',
              {
                path: filePath,
                count: matchInfo.count,
              },
            );
            return false;
          }
          loggingService.info('search_replace validation: normalized match(es) found', {
            path: filePath,
            count: matchInfo.count,
            replace_all,
          });
          return true;
        }

        // matchInfo.type === 'none'
        loggingService.warn('search_replace validation: no match found - will fail in execute', {
          path: filePath,
        });
        // Auto-approve - execute will handle the error gracefully
        return false;
      } catch (error: any) {
        loggingService.error('search_replace needsApproval error', {
          error: error?.message || String(error),
        });
        return true;
      }
    },
    execute: async (params) => {
      const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
      try {
        const { path: filePath, search_content, replace_content, replace_all = false } = params;
        const cwd = executionContext?.getCwd() || process.cwd();
        const targetPath = resolveWorkspacePath(filePath, cwd);

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

        if (enableFileLogging) {
          loggingService.info(`File operation started: search_replace`, {
            path: filePath,
            targetPath,
            replace_all,
          });
        }

        let content: string;
        try {
          content = await readFileFn(targetPath);
        } catch (error: any) {
          if (search_content === '' && error?.code === 'ENOENT') {
            await writeFileFn(targetPath, replace_content);
            if (enableFileLogging) {
              loggingService.info('File created (search_content empty)', {
                path: filePath,
              });
            }
            return JSON.stringify({
              output: [
                {
                  success: true,
                  operation: 'search_replace',
                  path: filePath,
                  message: `Created ${filePath} (new file)`,
                },
              ],
            });
          }
          throw error;
        }

        if (search_content === '') {
          return JSON.stringify({
            output: [
              {
                success: false,
                error:
                  'search_content must not be empty when editing an existing file. Provide search text or create a new file with an empty search.',
              },
            ],
          });
        }

        // Check for summarization markers
        const markerError = detectSummarizationMarkers(search_content);
        if (markerError) {
          return JSON.stringify({
            output: [
              {
                success: false,
                error: markerError,
              },
            ],
          });
        }

        // Check cache first
        const cacheKey = getEditCacheKey(params);
        let matchInfo: MatchInfo;
        let eol: string;
        let normalizedSearchContent: string;
        let normalizedReplaceContent: string;
        let usedHealing = false;
        let healingAttempted = false;
        let healingSucceeded = false;
        let healedSearchLength = 0;
        let matchTypeAfterHealing: MatchInfo['type'] = 'none';

        if (lastEditCache && lastEditCache.key === cacheKey && lastEditCache.content === content) {
          // Use cached results
          matchInfo = lastEditCache.matchInfo;
          eol = lastEditCache.eol;
          normalizedSearchContent = normalizeToEOL(removeLeadingFilepathComment(search_content, filePath), eol);
          normalizedReplaceContent = normalizeToEOL(replace_content, eol);
        } else {
          // Detect EOL and normalize content
          eol = detectEOL(content);
          normalizedSearchContent = normalizeToEOL(removeLeadingFilepathComment(search_content, filePath), eol);
          normalizedReplaceContent = normalizeToEOL(replace_content, eol);

          // Find matches using shared logic
          matchInfo = findMatchesInContent(content, normalizedSearchContent);
        }

        if (matchInfo.type === 'none') {
          const enableEditHealing = settingsService.get<boolean>('tools.enableEditHealing') ?? true;
          if (enableEditHealing) {
            healingAttempted = true;
            const healingModel = settingsService.get<string>('tools.editHealingModel') ?? 'gpt-4o-mini';
            const healingResult = await editHealing(params, content, healingModel, process.env.OPENAI_API_KEY ?? '', {
              settingsService,
              loggingService,
            });

            healedSearchLength = healingResult.params.search_content.length;

            if (healingResult.wasModified) {
              normalizedSearchContent = normalizeToEOL(
                removeLeadingFilepathComment(healingResult.params.search_content, filePath),
                eol,
              );
              matchInfo = findMatchesInContent(content, normalizedSearchContent);
              matchTypeAfterHealing = matchInfo.type;
              if (matchInfo.type !== 'none') {
                usedHealing = true;
                healingSucceeded = true;
              }
            }

            if (enableFileLogging) {
              loggingService.info('search_replace healing attempt', {
                path: filePath,
                healing_attempted: healingAttempted,
                healing_succeeded: healingSucceeded,
                original_search_length: search_content.length,
                healed_search_length: healedSearchLength,
                match_type_after_healing: matchTypeAfterHealing,
              });
            }

            if (!usedHealing) {
              return JSON.stringify({
                output: [
                  {
                    success: false,
                    error:
                      'Search content not found. Auto-healing attempted but no match found. Try splitting changes into smaller patterns.',
                  },
                ],
              });
            }
          }
        }

        if (matchInfo.type === 'exact') {
          let newContent: string;
          if (replace_all) {
            newContent = content.replaceAll(normalizedSearchContent, normalizedReplaceContent);
          } else {
            const firstIndex = content.indexOf(normalizedSearchContent);
            newContent =
              content.substring(0, firstIndex) +
              normalizedReplaceContent +
              content.substring(firstIndex + normalizedSearchContent.length);
          }
          await writeFileFn(targetPath, newContent);

          if (enableFileLogging) {
            loggingService.info('File updated (exact match)', {
              path: filePath,
              replace_all,
              count: replace_all ? matchInfo.count : 1,
              healed: usedHealing,
            });
          }

          const successMessage = usedHealing
            ? `Updated ${filePath} (healed match - original search had minor differences)`
            : `Updated ${filePath} (${replace_all ? matchInfo.count : 1} exact match${
                replace_all && matchInfo.count > 1 ? 'es' : ''
              })`;
          return JSON.stringify({
            output: [
              {
                success: true,
                operation: 'search_replace',
                path: filePath,
                message: successMessage,
                healed: usedHealing,
              },
            ],
          });
        }

        if (matchInfo.type === 'relaxed') {
          if (!replace_all && matchInfo.count > 1) {
            return JSON.stringify({
              output: [
                {
                  success: false,
                  error: `Found ${matchInfo.count} relaxed matches. Please provide more context or set replace_all to true.`,
                },
              ],
            });
          }

          let newContent = content;
          if (replace_all) {
            // Sort matches by startIndex descending to replace from end
            matchInfo.matches.sort((a, b) => b.startIndex - a.startIndex);
            for (const m of matchInfo.matches) {
              newContent =
                newContent.substring(0, m.startIndex) + normalizedReplaceContent + newContent.substring(m.endIndex);
            }
          } else {
            const m = matchInfo.matches[0];
            newContent = content.substring(0, m.startIndex) + normalizedReplaceContent + content.substring(m.endIndex);
          }
          await writeFileFn(targetPath, newContent);

          if (enableFileLogging) {
            loggingService.info('File updated (relaxed match)', {
              path: filePath,
              replace_all,
              count: replace_all ? matchInfo.count : 1,
              healed: usedHealing,
            });
          }

          const successMessage = usedHealing
            ? `Updated ${filePath} (healed match - original search had minor differences)`
            : `Updated ${filePath} (${replace_all ? matchInfo.count : 1} relaxed match${
                replace_all && matchInfo.count > 1 ? 'es' : ''
              })`;
          return JSON.stringify({
            output: [
              {
                success: true,
                operation: 'search_replace',
                path: filePath,
                message: successMessage,
                healed: usedHealing,
              },
            ],
          });
        }

        if (matchInfo.type === 'normalized') {
          if (!replace_all && matchInfo.count > 1) {
            return JSON.stringify({
              output: [
                {
                  success: false,
                  error: `Found ${matchInfo.count} normalized matches. Please provide more context or set replace_all to true.`,
                },
              ],
            });
          }

          let newContent = content;
          if (replace_all) {
            matchInfo.matches.sort((a, b) => b.startIndex - a.startIndex);
            for (const m of matchInfo.matches) {
              newContent =
                newContent.substring(0, m.startIndex) + normalizedReplaceContent + newContent.substring(m.endIndex);
            }
          } else {
            const m = matchInfo.matches[0];
            newContent = content.substring(0, m.startIndex) + normalizedReplaceContent + content.substring(m.endIndex);
          }
          await writeFileFn(targetPath, newContent);

          if (enableFileLogging) {
            loggingService.info('File updated (normalized match)', {
              path: filePath,
              replace_all,
              count: replace_all ? matchInfo.count : 1,
              healed: usedHealing,
            });
          }

          const successMessage = usedHealing
            ? `Updated ${filePath} (healed match - original search had minor differences)`
            : `Updated ${filePath} (${replace_all ? matchInfo.count : 1} normalized match${
                replace_all && matchInfo.count > 1 ? 'es' : ''
              })`;
          return JSON.stringify({
            output: [
              {
                success: true,
                operation: 'search_replace',
                path: filePath,
                message: successMessage,
                healed: usedHealing,
              },
            ],
          });
        }

        // matchInfo.type === 'none'
        return JSON.stringify({
          output: [
            {
              success: false,
              error: `Search content not found. Try splitting the changes into smaller search pattern.`,
            },
          ],
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
