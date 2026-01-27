import {z} from 'zod';
import {readFile, writeFile} from 'fs/promises';
import path from 'path';
import {resolveWorkspacePath} from './utils.js';
import type {ToolDefinition, CommandMessage} from './types.js';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';
import {
    getOutputText,
    safeJsonParse,
    normalizeToolArguments,
    createBaseMessage,
} from './format-helpers.js';
import { ExecutionContext } from '../services/execution-context.js';

const searchReplaceParametersSchema = z.object({
    path: z.string().describe('The absolute or relative path to the file'),
    search_content: z.string().describe('The exact content to search for'),
    replace_content: z.string().describe('The content to replace it with'),
    replace_all: z
        .boolean()
        .default(false)
        .describe(
            'Whether to replace all occurrences of the search content. If false, requires exactly one match.',
        ),
});

export type SearchReplaceToolParams = z.infer<
    typeof searchReplaceParametersSchema
>;

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
    matches: {startIndex: number; endIndex: number}[];
}

/**
 * Information about whitespace-normalized matches found in content
 */
interface NormalizedMatchInfo {
    type: 'normalized';
    count: number;
    matches: {startIndex: number; endIndex: number}[];
}

/**
 * Information indicating no matches were found
 */
interface NoMatchInfo {
    type: 'none';
}

type MatchInfo =
    | ExactMatchInfo
    | RelaxedMatchInfo
    | NormalizedMatchInfo
    | NoMatchInfo;

/**
 * Parse file content into lines with position information
 */
function parseFileLines(
    content: string,
): {text: string; trimmed: string; start: number; end: number}[] {
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

    return {normalized, indexMap};
}

function normalizeWhitespace(content: string): string {
    return normalizeWhitespaceWithMap(content).normalized;
}

/**
 * Find matches in content using exact matching first, then relaxed matching.
 * Returns detailed match information including positions for replacement.
 */
function findMatchesInContent(
    content: string,
    searchContent: string,
): MatchInfo {
    // 1. Try exact match first
    let matchCount = 0;
    let index = content.indexOf(searchContent);
    while (index !== -1) {
        matchCount++;
        index = content.indexOf(searchContent, index + 1);
    }

    if (matchCount > 0) {
        return {type: 'exact', count: matchCount};
    }

    // 2. Try relaxed match (whitespace-insensitive line matching)
    const searchLines = searchContent.split(/\r?\n/).map(l => l.trim());
    const lineInfos = parseFileLines(content);

    const matches: {startIndex: number; endIndex: number}[] = [];
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
        return {type: 'relaxed', count: matches.length, matches};
    }

    // 3. Try normalized whitespace match (collapse whitespace differences)
    const normalizedSearch = normalizeWhitespace(searchContent);
    if (normalizedSearch.length > 0) {
        const {normalized: normalizedContent, indexMap} =
            normalizeWhitespaceWithMap(content);
        const normalizedMatches: {startIndex: number; endIndex: number}[] = [];
        let normalizedIndex = normalizedContent.indexOf(normalizedSearch);
        while (normalizedIndex !== -1) {
            const beforeIndex = normalizedIndex - 1;
            const afterIndex = normalizedIndex + normalizedSearch.length;
            const beforeChar =
                beforeIndex >= 0 ? normalizedContent[beforeIndex] : '';
            const afterChar =
                afterIndex < normalizedContent.length
                    ? normalizedContent[afterIndex]
                    : '';
            const hasLeadingBoundary =
                beforeIndex < 0 || beforeChar === ' ';
            const hasTrailingBoundary =
                afterIndex >= normalizedContent.length || afterChar === ' ';

            if (!hasLeadingBoundary || !hasTrailingBoundary) {
                normalizedIndex = normalizedContent.indexOf(
                    normalizedSearch,
                    normalizedIndex + 1,
                );
                continue;
            }

            const startIndex = indexMap[normalizedIndex];
            const endIndex =
                indexMap[normalizedIndex + normalizedSearch.length - 1] + 1;
            normalizedMatches.push({startIndex, endIndex});
            normalizedIndex = normalizedContent.indexOf(
                normalizedSearch,
                normalizedIndex + 1,
            );
        }

        if (normalizedMatches.length > 0) {
            return {
                type: 'normalized',
                count: normalizedMatches.length,
                matches: normalizedMatches,
            };
        }
    }

    return {type: 'none'};
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
        const output =
            replaceResult?.message ?? replaceResult?.error ?? 'No output';
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
}): ToolDefinition<SearchReplaceToolParams> {
    const { loggingService, settingsService, executionContext } = deps;

    return {
        name: 'search_replace',
        description:
            'Replace text in a file using exact or relaxed matching.\n' +
            'Set replace_all to true to replace all occurrences instead of requiring a unique match.\n' +
            'Use this tool for precise edits where you know the content to be replaced.',
        parameters: searchReplaceParametersSchema,
        needsApproval: async params => {
            try {
                const editMode = settingsService.get<boolean>('app.editMode');
                const {
                    path: filePath,
                    search_content,
                    replace_all = false,
                } = params;
                const cwd = executionContext?.getCwd() || process.cwd();
                const targetPath = resolveWorkspacePath(filePath, cwd);
                const workspaceRoot = cwd;
                const insideCwd = targetPath.startsWith(
                    workspaceRoot + path.sep,
                );

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
                        loggingService.info(
                            'search_replace validation: creating new file because search_content is empty',
                            {
                                path: filePath,
                            },
                        );
                        if (editMode && insideCwd) {
                            return false;
                        }
                        return true;
                    }
                    loggingService.error(
                        'search_replace needsApproval: file not found',
                        {
                            path: filePath,
                            error: error?.message || String(error),
                        },
                    );
                    return true;
                }

                if (search_content === '') {
                    loggingService.warn(
                        'search_replace validation: empty search_content on existing file',
                        {
                            path: filePath,
                        },
                    );
                    return true;
                }

                // Find matches using shared logic
                const matchInfo = findMatchesInContent(content, search_content);

                if (matchInfo.type === 'exact') {
                    if (!replace_all && matchInfo.count > 1) {
                        loggingService.warn(
                            'search_replace validation: multiple exact matches, replace_all=false',
                            {
                                path: filePath,
                                count: matchInfo.count,
                            },
                        );
                        return true;
                    }
                    loggingService.info(
                        'search_replace validation: exact match(es) found',
                        {
                            path: filePath,
                            count: matchInfo.count,
                            replace_all,
                        },
                    );
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
                    loggingService.info(
                        'search_replace validation: relaxed match(es) found',
                        {
                            path: filePath,
                            count: matchInfo.count,
                            replace_all,
                        },
                    );
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
                    loggingService.info(
                        'search_replace validation: normalized match(es) found',
                        {
                            path: filePath,
                            count: matchInfo.count,
                            replace_all,
                        },
                    );
                    return true;
                }

                // matchInfo.type === 'none'
                loggingService.warn(
                    'search_replace validation: no match found - will fail in execute',
                    {
                        path: filePath,
                    },
                );
                // Auto-approve - execute will handle the error gracefully
                return false;
            } catch (error: any) {
                loggingService.error('search_replace needsApproval error', {
                    error: error?.message || String(error),
                });
                return true;
            }
        },
        execute: async params => {
            const enableFileLogging = settingsService.get<boolean>(
                'tools.logFileOperations',
            );
            try {
                const {
                    path: filePath,
                    search_content,
                    replace_content,
                    replace_all = false,
                } = params;
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
                    loggingService.info(
                        `File operation started: search_replace`,
                        {
                            path: filePath,
                            targetPath,
                            replace_all,
                        },
                    );
                }

                let content: string;
                try {
                    content = await readFileFn(targetPath);
                } catch (error: any) {
                    if (search_content === '' && error?.code === 'ENOENT') {
                        await writeFileFn(targetPath, replace_content);
                        if (enableFileLogging) {
                            loggingService.info(
                                'File created (search_content empty)',
                                {
                                    path: filePath,
                                },
                            );
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
                                error: 'search_content must not be empty when editing an existing file. Provide search text or create a new file with an empty search.',
                            },
                        ],
                    });
                }

                // Find matches using shared logic
                const matchInfo = findMatchesInContent(content, search_content);

                if (matchInfo.type === 'exact') {
                    let newContent: string;
                    if (replace_all) {
                        newContent = content.replaceAll(
                            search_content,
                            replace_content,
                        );
                    } else {
                        const firstIndex = content.indexOf(search_content);
                        newContent =
                            content.substring(0, firstIndex) +
                            replace_content +
                            content.substring(
                                firstIndex + search_content.length,
                            );
                    }
                    await writeFileFn(targetPath, newContent);

                    if (enableFileLogging) {
                        loggingService.info('File updated (exact match)', {
                            path: filePath,
                            replace_all,
                            count: replace_all ? matchInfo.count : 1,
                        });
                    }

                    return JSON.stringify({
                        output: [
                            {
                                success: true,
                                operation: 'search_replace',
                                path: filePath,
                                message: `Updated ${filePath} (${
                                    replace_all ? matchInfo.count : 1
                                } exact match${
                                    replace_all && matchInfo.count > 1
                                        ? 'es'
                                        : ''
                                })`,
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
                        matchInfo.matches.sort(
                            (a, b) => b.startIndex - a.startIndex,
                        );
                        for (const m of matchInfo.matches) {
                            newContent =
                                newContent.substring(0, m.startIndex) +
                                replace_content +
                                newContent.substring(m.endIndex);
                        }
                    } else {
                        const m = matchInfo.matches[0];
                        newContent =
                            content.substring(0, m.startIndex) +
                            replace_content +
                            content.substring(m.endIndex);
                    }
                    await writeFileFn(targetPath, newContent);

                    if (enableFileLogging) {
                        loggingService.info('File updated (relaxed match)', {
                            path: filePath,
                            replace_all,
                            count: replace_all ? matchInfo.count : 1,
                        });
                    }

                    return JSON.stringify({
                        output: [
                            {
                                success: true,
                                operation: 'search_replace',
                                path: filePath,
                                message: `Updated ${filePath} (${
                                    replace_all ? matchInfo.count : 1
                                } relaxed match${
                                    replace_all && matchInfo.count > 1
                                        ? 'es'
                                        : ''
                                })`,
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
                        matchInfo.matches.sort(
                            (a, b) => b.startIndex - a.startIndex,
                        );
                        for (const m of matchInfo.matches) {
                            newContent =
                                newContent.substring(0, m.startIndex) +
                                replace_content +
                                newContent.substring(m.endIndex);
                        }
                    } else {
                        const m = matchInfo.matches[0];
                        newContent =
                            content.substring(0, m.startIndex) +
                            replace_content +
                            content.substring(m.endIndex);
                    }
                    await writeFileFn(targetPath, newContent);

                    if (enableFileLogging) {
                        loggingService.info(
                            'File updated (normalized match)',
                            {
                                path: filePath,
                                replace_all,
                                count: replace_all ? matchInfo.count : 1,
                            },
                        );
                    }

                    return JSON.stringify({
                        output: [
                            {
                                success: true,
                                operation: 'search_replace',
                                path: filePath,
                                message: `Updated ${filePath} (${
                                    replace_all ? matchInfo.count : 1
                                } normalized match${
                                    replace_all && matchInfo.count > 1
                                        ? 'es'
                                        : ''
                                })`,
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
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
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
