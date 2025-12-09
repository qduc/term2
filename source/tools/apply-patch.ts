import {z} from 'zod';
import {readFile, writeFile, mkdir, rm} from 'fs/promises';
import path from 'path';
import {applyDiff} from '@openai/agents';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';
import type {ToolDefinition} from './types.js';

/**
 * Error thrown when patch validation fails (malformed diff)
 */
export class PatchValidationError extends Error {
    constructor(message: string, public filePath: string) {
        super(message);
        this.name = 'PatchValidationError';
    }
}

const applyPatchParametersSchema = z.object({
    type: z.enum(['create_file', 'update_file', 'delete_file']),
    path: z.string().min(1, 'File path cannot be empty'),
    diff: z
        .string()
        .describe('Unified diff content for create/update operations'),
});

export type ApplyPatchToolParams = z.infer<typeof applyPatchParametersSchema>;

/**
 * Resolves a relative path and ensures it's within the workspace
 */
function resolveWorkspacePath(relativePath: string): string {
    const workspaceRoot = process.cwd();
    const resolved = path.resolve(workspaceRoot, relativePath);

    if (!resolved.startsWith(workspaceRoot)) {
        throw new Error(`Operation outside workspace: ${relativePath}`);
    }

    return resolved;
}

export const applyPatchToolDefinition: ToolDefinition<ApplyPatchToolParams> = {
    name: 'apply_patch',
    description:
        'Apply file changes using unified diff format. Supports creating, updating, and deleting files. ' +
        'For create_file and update_file operations, provide a unified diff. ' +
        'The diff format should use +/- prefixes for added/removed lines. ' +
        'Example diff:\n' +
        '```\n' +
        '-old line\n' +
        '+new line\n' +
        '```',
    parameters: applyPatchParametersSchema,
    needsApproval: async params => {
        try {
            const mode = settingsService.get<'default' | 'edit'>('app.mode');
            const {type, path: filePath, diff} = params;

            // Validate diff syntax by attempting a dry-run (before approval)
            if (type === 'create_file' || type === 'update_file') {
                try {
                    if (type === 'create_file') {
                        // Dry-run: apply diff to empty content for new file
                        applyDiff('', diff, 'create');
                    } else {
                        // Dry-run: read existing file and test diff application
                        const targetPath = resolveWorkspacePath(filePath);
                        const original = await readFile(targetPath, 'utf8');
                        applyDiff(original, diff);
                    }
                    loggingService.info('apply_patch validation passed', {
                        type,
                        path: filePath,
                    });
                } catch (diffError: any) {
                    // Diff validation failed - reject immediately without user approval
                    loggingService.error('apply_patch validation failed', {
                        type,
                        path: filePath,
                        error: diffError?.message || String(diffError),
                    });
                    throw new PatchValidationError(
                        `Invalid diff: ${diffError?.message || String(diffError)}`,
                        filePath
                    );
                }
            }

            // Deletions ALWAYS require approval per policy
            if (type === 'delete_file') {
                loggingService.security('apply_patch needsApproval: delete requires approval', {
                    mode,
                    type,
                    path: filePath,
                });
                return true;
            }

            // Resolve and ensure target within workspace
            const workspaceRoot = process.cwd();
            let targetPath: string;
            try {
                targetPath = resolveWorkspacePath(filePath);
            } catch (e: any) {
                // Outside workspace => require approval
                loggingService.security('apply_patch needsApproval: outside workspace', {
                    mode,
                    type,
                    path: filePath,
                    error: e?.message || String(e),
                });
                return true;
            }

            const insideCwd = targetPath.startsWith(workspaceRoot + path.sep);

            // In edit mode, auto-approve create/update within cwd
            if (
                mode === 'edit' &&
                insideCwd &&
                (type === 'create_file' || type === 'update_file')
            ) {
                loggingService.security('apply_patch needsApproval: auto-approved in edit mode', {
                    mode,
                    type,
                    path: filePath,
                    targetPath,
                });
                return false;
            }

            // Otherwise, require approval (default behavior)
            loggingService.security('apply_patch needsApproval: approval required', {
                mode,
                type,
                path: filePath,
                targetPath,
                insideCwd,
            });
            return true;
        } catch (error: any) {
            loggingService.error('apply_patch needsApproval error', {
                error: error?.message || String(error),
            });
            // Fail-safe: require approval on any error
            return true;
        }
    },
    execute: async params => {
        const enableFileLogging =
            settingsService.get<boolean>('tools.logFileOperations');

        try {
            const {type, path: filePath, diff} = params;
            const targetPath = resolveWorkspacePath(filePath);

            if (enableFileLogging) {
                loggingService.info(`File operation started: ${type}`, {
                    path: filePath,
                    targetPath,
                });
            }

            switch (type) {
                case 'create_file': {
                    // Ensure parent directory exists
                    await mkdir(path.dirname(targetPath), {recursive: true});

                    // Apply diff to empty content for new file
                    const content = applyDiff('', diff, 'create');
                    await writeFile(targetPath, content, 'utf8');

                    if (enableFileLogging) {
                        try {
                            loggingService.info('File created', {
                                path: filePath,
                                contentLength: content.length,
                            });
                        } catch (error) {
                            // Ignore logging errors to prevent operation failure
                        }
                    }

                    return JSON.stringify({
                        success: true,
                        operation: 'create_file',
                        path: filePath,
                        message: `Created ${filePath}`,
                    });
                }

                case 'update_file': {
                    // Read existing file
                    let original: string;
                    try {
                        original = await readFile(targetPath, 'utf8');
                    } catch (error: any) {
                        if (error?.code === 'ENOENT') {
                            if (enableFileLogging) {
                                loggingService.error(
                                    'Cannot update missing file',
                                    {
                                        path: filePath,
                                        targetPath,
                                    },
                                );
                            }
                            return JSON.stringify({
                                success: false,
                                error: `Cannot update missing file: ${filePath}`,
                            });
                        }

                        throw error;
                    }

                    // Apply diff to existing content
                    const patched = applyDiff(original, diff);
                    await writeFile(targetPath, patched, 'utf8');

                    if (enableFileLogging) {
                        try {
                            loggingService.info('File updated', {
                                path: filePath,
                                originalLength: original.length,
                                patchedLength: patched.length,
                            });
                        } catch (error) {
                            // Ignore logging errors to prevent operation failure
                        }
                    }

                    return JSON.stringify({
                        success: true,
                        operation: 'update_file',
                        path: filePath,
                        message: `Updated ${filePath}`,
                    });
                }

                case 'delete_file': {
                    await rm(targetPath, {force: true});

                    if (enableFileLogging) {
                        try {
                            loggingService.info('File deleted', {
                                path: filePath,
                                targetPath,
                            });
                        } catch (error) {
                            // Ignore logging errors to prevent operation failure
                        }
                    }

                    return JSON.stringify({
                        success: true,
                        operation: 'delete_file',
                        path: filePath,
                        message: `Deleted ${filePath}`,
                    });
                }

                default: {
                    return JSON.stringify({
                        success: false,
                        error: `Unknown operation type: ${type}`,
                    });
                }
            }
        } catch (error: any) {
            if (enableFileLogging) {
                loggingService.error('File operation failed', {
                    type: params.type,
                    path: params.path,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
            return JSON.stringify({
                success: false,
                error: error.message || String(error),
            });
        }
    },
};
