import {readFile, writeFile, mkdir, rm} from 'fs/promises';
import path from 'path';
import {applyDiff} from '@openai/agents';
import type {ApplyPatchOperation, ApplyPatchResult} from '@openai/agents';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';

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

/**
 * Create editor implementation that performs actual file operations.
 * Used by the native applyPatchTool from the SDK.
 */
export function createEditorImpl(deps: {
    loggingService: ILoggingService;
    settingsService: ISettingsService;
}) {
    const {loggingService, settingsService} = deps;

    return {
        async createFile(
            operation: Extract<ApplyPatchOperation, {type: 'create_file'}>,
        ): Promise<ApplyPatchResult> {
            const enableFileLogging = settingsService.get<boolean>(
                'tools.logFileOperations',
            );
            const {path: filePath, diff} = operation;

            try {
                const targetPath = resolveWorkspacePath(filePath);

                if (enableFileLogging) {
                    loggingService.info('File operation started: create_file', {
                        path: filePath,
                        targetPath,
                    });
                }

                // Validate patch before executing
                try {
                    applyDiff('', diff);
                } catch (validationError: any) {
                    loggingService.error(
                        'Patch validation failed in createFile',
                        {
                            path: filePath,
                            error:
                                validationError?.message ||
                                String(validationError),
                        },
                    );
                    return {
                        status: 'failed',
                        output: `Invalid patch: ${
                            validationError?.message || String(validationError)
                        }. Please check the file path and diff format.`,
                    };
                }

                // Ensure parent directory exists
                await mkdir(path.dirname(targetPath), {recursive: true});

                // Apply diff to empty content for new file
                const content = applyDiff('', diff);
                await writeFile(targetPath, content, 'utf8');

                if (enableFileLogging) {
                    loggingService.info('File created', {
                        path: filePath,
                        contentLength: content.length,
                    });
                }

                return {
                    status: 'completed',
                    output: `Created ${filePath}`,
                };
            } catch (error: any) {
                if (enableFileLogging) {
                    loggingService.error('File operation failed', {
                        type: 'create_file',
                        path: filePath,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
                return {
                    status: 'failed',
                    output: error.message || String(error),
                };
            }
        },

        async updateFile(
            operation: Extract<ApplyPatchOperation, {type: 'update_file'}>,
        ): Promise<ApplyPatchResult> {
            const enableFileLogging = settingsService.get<boolean>(
                'tools.logFileOperations',
            );
            const {path: filePath, diff} = operation;

            try {
                const targetPath = resolveWorkspacePath(filePath);

                if (enableFileLogging) {
                    loggingService.info('File operation started: update_file', {
                        path: filePath,
                        targetPath,
                    });
                }

                // Read existing file
                let original: string;
                try {
                    original = await readFile(targetPath, 'utf8');
                } catch (error: any) {
                    if (error?.code === 'ENOENT') {
                        if (enableFileLogging) {
                            loggingService.error('Cannot update missing file', {
                                path: filePath,
                                targetPath,
                            });
                        }
                        return {
                            status: 'failed',
                            output: `Cannot update missing file: ${filePath}`,
                        };
                    }
                    throw error;
                }

                // Validate patch before executing
                try {
                    applyDiff(original, diff);
                } catch (validationError: any) {
                    loggingService.error(
                        'Patch validation failed in updateFile',
                        {
                            path: filePath,
                            error:
                                validationError?.message ||
                                String(validationError),
                        },
                    );
                    return {
                        status: 'failed',
                        output: `Invalid patch: ${
                            validationError?.message || String(validationError)
                        }. Please check the file path and diff format.`,
                    };
                }

                // Apply diff to existing content
                const patched = applyDiff(original, diff);
                await writeFile(targetPath, patched, 'utf8');

                if (enableFileLogging) {
                    loggingService.info('File updated', {
                        path: filePath,
                        originalLength: original.length,
                        patchedLength: patched.length,
                    });
                }

                return {
                    status: 'completed',
                    output: `Updated ${filePath}`,
                };
            } catch (error: any) {
                if (enableFileLogging) {
                    loggingService.error('File operation failed', {
                        type: 'update_file',
                        path: filePath,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
                return {
                    status: 'failed',
                    output: error.message || String(error),
                };
            }
        },

        async deleteFile(
            operation: Extract<ApplyPatchOperation, {type: 'delete_file'}>,
        ): Promise<ApplyPatchResult> {
            const enableFileLogging = settingsService.get<boolean>(
                'tools.logFileOperations',
            );
            const {path: filePath} = operation;

            try {
                const targetPath = resolveWorkspacePath(filePath);

                if (enableFileLogging) {
                    loggingService.info('File operation started: delete_file', {
                        path: filePath,
                        targetPath,
                    });
                }

                await rm(targetPath, {force: true});

                if (enableFileLogging) {
                    loggingService.info('File deleted', {
                        path: filePath,
                        targetPath,
                    });
                }

                return {
                    status: 'completed',
                    output: `Deleted ${filePath}`,
                };
            } catch (error: any) {
                if (enableFileLogging) {
                    loggingService.error('File operation failed', {
                        type: 'delete_file',
                        path: filePath,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
                return {
                    status: 'failed',
                    output: error.message || String(error),
                };
            }
        },
    };
}
