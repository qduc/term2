import {z} from 'zod';
import {readFile, writeFile} from 'fs/promises';
import path from 'path';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';
import {resolveWorkspacePath} from './utils.js';
import type {ToolDefinition} from './types.js';

const searchReplaceParametersSchema = z.object({
    path: z.string().describe('The absolute or relative path to the file'),
    search_content: z.string().describe('The exact content to search for'),
    replace_content: z.string().describe('The content to replace it with'),
    replace_all: z.boolean().default(false).describe('Whether to replace all occurrences of the search content. If false, requires exactly one match.'),
});

export type SearchReplaceToolParams = z.infer<typeof searchReplaceParametersSchema>;

export const searchReplaceToolDefinition: ToolDefinition<SearchReplaceToolParams> = {
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

            // 1. Exact match check
            let matchCount = 0;
            let index = content.indexOf(search_content);
            while (index !== -1) {
                matchCount++;
                index = content.indexOf(search_content, index + 1);
            }

            if (matchCount > 0) {
                if (!replace_all && matchCount > 1) {
                    loggingService.warn('search_replace validation: multiple exact matches, replace_all=false', {
                        path: filePath,
                        count: matchCount,
                    });
                    return true;
                }
                loggingService.info('search_replace validation: exact match(es) found', {
                    path: filePath,
                    count: matchCount,
                    replace_all,
                });
                if (mode === 'edit' && insideCwd) {
                    return false;
                }
                return true;
            }

            // 2. Relaxed match check
            const searchLines = search_content.split(/\r?\n/).map(l => l.trim());
            const fileLines = content.split(/\r?\n/);

            let relaxedMatchCount = 0;
            for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
                let match = true;
                for (let j = 0; j < searchLines.length; j++) {
                    if (fileLines[i + j].trim() !== searchLines[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    relaxedMatchCount++;
                }
            }

            if (relaxedMatchCount > 0) {
                if (!replace_all && relaxedMatchCount > 1) {
                    loggingService.warn('search_replace validation: multiple relaxed matches, replace_all=false', {
                        path: filePath,
                        count: relaxedMatchCount,
                    });
                    return true;
                }
                loggingService.info('search_replace validation: relaxed match(es) found', {
                    path: filePath,
                    count: relaxedMatchCount,
                    replace_all,
                });
                return true;
            }

            loggingService.warn('search_replace validation: no match found', {
                path: filePath,
            });
            return true;

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

            // 1. Try Exact Match
            let matchCount = 0;
            let index = content.indexOf(search_content);
            while (index !== -1) {
                matchCount++;
                index = content.indexOf(search_content, index + 1);
            }

            if (matchCount > 0) {
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
                        count: replace_all ? matchCount : 1,
                    });
                }

                return JSON.stringify({
                    output: [{
                        success: true,
                        operation: 'search_replace',
                        path: filePath,
                        message: `Updated ${filePath} (${replace_all ? matchCount : 1} exact match${replace_all && matchCount > 1 ? 'es' : ''})`
                    }]
                });
            }

            // 2. Try Relaxed Match
            const searchLines = search_content.split(/\r?\n/).map(l => l.trim());

            // Parse file into lines with indices
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
                if (!replace_all && matches.length > 1) {
                    return JSON.stringify({
                        output: [{
                            success: false,
                            error: `Found ${matches.length} relaxed matches. Please provide more context or set replace_all to true.`
                        }]
                    });
                }

                let newContent = content;
                if (replace_all) {
                    // Sort matches by startIndex descending to replace from end
                    matches.sort((a, b) => b.startIndex - a.startIndex);
                    for (const m of matches) {
                        newContent = newContent.substring(0, m.startIndex) + replace_content + newContent.substring(m.endIndex);
                    }
                } else {
                    const m = matches[0];
                    newContent = content.substring(0, m.startIndex) + replace_content + content.substring(m.endIndex);
                }
                await writeFile(targetPath, newContent, 'utf8');

                if (enableFileLogging) {
                    loggingService.info('File updated (relaxed match)', {
                        path: filePath,
                        replace_all,
                        count: replace_all ? matches.length : 1,
                    });
                }

                return JSON.stringify({
                    output: [{
                        success: true,
                        operation: 'search_replace',
                        path: filePath,
                        message: `Updated ${filePath} (${replace_all ? matches.length : 1} relaxed match${replace_all && matches.length > 1 ? 'es' : ''})`
                    }]
                });
            }

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
