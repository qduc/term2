import {z} from 'zod';
import {readFile, writeFile} from 'fs/promises';
import path from 'path';
import {resolveWorkspacePath} from './utils.js';
import type {ToolDefinition} from './types.js';
import type {ILoggingService, ISettingsService} from '../services/service-interfaces.js';

const searchReplaceParametersSchema = z.object({
    path: z.string().describe('The absolute or relative path to the file'),
    search_content: z.string().describe('The exact content to search for'),
    replace_content: z.string().describe('The content to replace it with'),
    replace_all: z.boolean().describe('Whether to replace all occurrences of the search content. If false, requires exactly one match.'),
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
    matches: {startIndex: number, endIndex: number}[];
}

/**
 * Information indicating no matches were found
 */
interface NoMatchInfo {
    type: 'none';
}

type MatchInfo = ExactMatchInfo | RelaxedMatchInfo | NoMatchInfo;

/**
 * Parse file content into lines with position information
 */
function parseFileLines(content: string): {text: string, trimmed: string, start: number, end: number}[] {
    const lineInfos: {text: string, trimmed: string, start: number, end: number}[] = [];
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
            end: match.index + fullMatch.length
        });

        if (match.index + fullMatch.length === content.length) break;
    }
    return lineInfos;
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
    const searchLines = searchContent.split(/\r?\n/).map(l => l.trim());
    const lineInfos = parseFileLines(content);

    const matches: {startIndex: number, endIndex: number}[] = [];
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
                endIndex: lineInfos[i + searchLines.length - 1].end
            });
        }
    }

    if (matches.length > 0) {
        return { type: 'relaxed', count: matches.length, matches };
    }

    return { type: 'none' };
}

export function createSearchReplaceToolDefinition(deps: {
    loggingService: ILoggingService;
    settingsService: ISettingsService;
}): ToolDefinition<SearchReplaceToolParams> {
    const {loggingService, settingsService} = deps;

    return {
    name: 'search_replace',
    description:
        'Replace text in a file using exact or relaxed matching.\n' +
        'Set replace_all to true to replace all occurrences instead of requiring a unique match.\n' +
        'Use this tool for precise edits where you know the content to be replaced.',
    parameters: searchReplaceParametersSchema,
    needsApproval: async params => {
        try {
            const mode = settingsService.get<'default' | 'edit'>('app.mode');
            const {path: filePath, search_content, replace_all = false} = params;
            const targetPath = resolveWorkspacePath(filePath);
            const workspaceRoot = process.cwd();
            const insideCwd = targetPath.startsWith(workspaceRoot + path.sep);

            // Read file content
            let content: string;
            try {
                content = await readFile(targetPath, 'utf8');
            } catch (error: any) {
                if (search_content === '' && error?.code === 'ENOENT') {
                    loggingService.info('search_replace validation: creating new file because search_content is empty', {
                        path: filePath,
                    });
                    if (mode === 'edit' && insideCwd) {
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

            // Find matches using shared logic
            const matchInfo = findMatchesInContent(content, search_content);

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
                if (mode === 'edit' && insideCwd) {
                    return false;
                }
                return true;
            }

            if (matchInfo.type === 'relaxed') {
                if (!replace_all && matchInfo.count > 1) {
                    loggingService.warn('search_replace validation: multiple relaxed matches, replace_all=false - will fail in execute', {
                        path: filePath,
                        count: matchInfo.count,
                    });
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
    execute: async params => {
        const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
        try {
            const {path: filePath, search_content, replace_content, replace_all = false} = params;
            const targetPath = resolveWorkspacePath(filePath);

            if (enableFileLogging) {
                loggingService.info(`File operation started: search_replace`, {
                    path: filePath,
                    targetPath,
                    replace_all,
                });
            }

            let content: string;
            try {
                content = await readFile(targetPath, 'utf8');
            } catch (error: any) {
                if (search_content === '' && error?.code === 'ENOENT') {
                    await writeFile(targetPath, replace_content, 'utf8');
                    if (enableFileLogging) {
                        loggingService.info('File created (search_content empty)', {
                            path: filePath,
                        });
                    }
                    return JSON.stringify({
                        output: [{
                            success: true,
                            operation: 'search_replace',
                            path: filePath,
                            message: `Created ${filePath} (new file)`
                        }]
                    });
                }
                throw error;
            }

            if (search_content === '') {
                return JSON.stringify({
                    output: [{
                        success: false,
                        error: 'search_content must not be empty when editing an existing file. Provide search text or create a new file with an empty search.'
                    }]
                });
            }

            // Find matches using shared logic
            const matchInfo = findMatchesInContent(content, search_content);

            if (matchInfo.type === 'exact') {
                let newContent: string;
                if (replace_all) {
                    newContent = content.replaceAll(search_content, replace_content);
                } else {
                    const firstIndex = content.indexOf(search_content);
                    newContent = content.substring(0, firstIndex) + replace_content + content.substring(firstIndex + search_content.length);
                }
                await writeFile(targetPath, newContent, 'utf8');

                if (enableFileLogging) {
                    loggingService.info('File updated (exact match)', {
                        path: filePath,
                        replace_all,
                        count: replace_all ? matchInfo.count : 1,
                    });
                }

                return JSON.stringify({
                    output: [{
                        success: true,
                        operation: 'search_replace',
                        path: filePath,
                        message: `Updated ${filePath} (${replace_all ? matchInfo.count : 1} exact match${replace_all && matchInfo.count > 1 ? 'es' : ''})`
                    }]
                });
            }

            if (matchInfo.type === 'relaxed') {
                if (!replace_all && matchInfo.count > 1) {
                    return JSON.stringify({
                        output: [{
                            success: false,
                            error: `Found ${matchInfo.count} relaxed matches. Please provide more context or set replace_all to true.`
                        }]
                    });
                }

                let newContent = content;
                if (replace_all) {
                    // Sort matches by startIndex descending to replace from end
                    matchInfo.matches.sort((a, b) => b.startIndex - a.startIndex);
                    for (const m of matchInfo.matches) {
                        newContent = newContent.substring(0, m.startIndex) + replace_content + newContent.substring(m.endIndex);
                    }
                } else {
                    const m = matchInfo.matches[0];
                    newContent = content.substring(0, m.startIndex) + replace_content + content.substring(m.endIndex);
                }
                await writeFile(targetPath, newContent, 'utf8');

                if (enableFileLogging) {
                    loggingService.info('File updated (relaxed match)', {
                        path: filePath,
                        replace_all,
                        count: replace_all ? matchInfo.count : 1,
                    });
                }

                return JSON.stringify({
                    output: [{
                        success: true,
                        operation: 'search_replace',
                        path: filePath,
                        message: `Updated ${filePath} (${replace_all ? matchInfo.count : 1} relaxed match${replace_all && matchInfo.count > 1 ? 'es' : ''})`
                    }]
                });
            }

            // matchInfo.type === 'none'
            return JSON.stringify({
                output: [{
                    success: false,
                    error: `Search content not found (even with relaxed matching). Please check the file content.`
                }]
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
    }
};
}
