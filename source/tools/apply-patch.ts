import {z} from 'zod';
import {readFile, writeFile, mkdir} from 'fs/promises';
import path from 'path';
import {applyDiff} from '@openai/agents';
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
    type: z.enum(['create_file', 'update_file']),
    path: z.string().min(1, 'File path cannot be empty'),
    diff: z
        .string()
        .describe('Unified diff content for create/update operations'),
});

export type ApplyPatchToolParams = z.infer<typeof applyPatchParametersSchema>;

export const formatApplyPatchCommandMessage = (
    item: any,
    index: number,
    _toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const parsedOutput = safeJsonParse(getOutputText(item));
    const patchOutputItems = parsedOutput?.output ?? [];

    // If JSON parsing failed or no output array, create error message
    if (patchOutputItems.length === 0) {
        const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
        const args = normalizeToolArguments(normalizedArgs) ?? {};
        const operationType = args?.type ?? 'unknown';
        const filePath = args?.path ?? 'unknown';
        const command = `apply_patch ${operationType} ${filePath}`;
        const output = getOutputText(item) || 'No output';
        const success = false;

        return [
            createBaseMessage(item, index, 0, false, {
                command,
                output,
                success,
            }),
        ];
    }

    // Apply patch tool can have multiple operation outputs
    const messages: CommandMessage[] = [];
    for (const [patchIndex, patchResult] of patchOutputItems.entries()) {
        const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
        const args = normalizeToolArguments(normalizedArgs) ?? {};
        const operationType =
            args?.type ?? patchResult?.operation ?? 'unknown';
        const filePath = args?.path ?? patchResult?.path ?? 'unknown';

        const command = `apply_patch ${operationType} ${filePath}`;
        const output =
            patchResult?.message ?? patchResult?.error ?? 'No output';
        const success = patchResult?.success ?? false;

        messages.push(
            createBaseMessage(item, index, patchIndex, false, {
                command,
                output,
                success,
            }),
        );
    }
    return messages;
};

export function createApplyPatchToolDefinition(deps: {
    loggingService: ILoggingService;
    settingsService: ISettingsService;
    executionContext?: ExecutionContext;
}): ToolDefinition<ApplyPatchToolParams> {
    const { loggingService, settingsService, executionContext } = deps;

    return {
        name: 'apply_patch',
        description:
            'Apply file changes using headerless V4A diff format. Supports creating, updating files.\n\n' +
            '## CRITICAL RULES:\n' +
            '1. Each line MUST start with exactly one character: space, +, or - (followed by the line content)\n' +
            '2. Use @@ markers to provide context anchors when needed\n' +
            '3. Context lines (unchanged) start with a SPACE character\n' +
            '4. Added lines start with + character\n' +
            '5. Removed lines start with - character\n' +
            '6. DO NOT include line numbers or @@ -n,m +n,m @@ headers (headerless format)\n\n' +
            '## CREATE_FILE:\n' +
            'Every line must start with + (no context or - lines):\n' +
            '```\n' +
            '+line 1\n' +
            '+line 2\n' +
            '+line 3\n' +
            '```\n\n' +
            '## UPDATE_FILE:\n' +
            'Provide context (space-prefixed lines) around changes. Include 2-3 lines of context before and after:\n' +
            '```\n' +
            '@@ function calculate\n' +
            ' function calculate(x) {\n' +
            '-  return x * 2;\n' +
            '+  return x * 3;\n' +
            ' }\n' +
            '```\n\n' +
            '## Context Anchors:\n' +
            'Use @@ markers to help locate code in the file:\n' +
            '- For classes: @@ class ClassName\n' +
            '- For functions: @@ function functionName\n' +
            '- For unique lines: @@ distinctive text from the line\n' +
            'Stack multiple @@ for nested structures:\n' +
            '```\n' +
            '@@ class MyClass\n' +
            '@@ method doSomething\n' +
            ' def doSomething(self):\n' +
            '-    old code\n' +
            '+    new code\n' +
            '```\n\n' +
            '## Common Mistakes to Avoid:\n' +
            '- Missing space/+/- prefix on lines\n' +
            '- Including line numbers like "@@ -1,3 +1,4 @@"\n' +
            '- Not providing enough context (need 2-3 lines before/after)\n' +
            '- Context lines not starting with space character\n' +
            '- Using tabs instead of spaces for indentation matching',
        parameters: applyPatchParametersSchema,
        needsApproval: async params => {
            try {
                const editMode = settingsService.get<boolean>('app.editMode');
                const {type, path: filePath, diff} = params;

                // Validate diff syntax by attempting a dry-run (before approval)
                if (type === 'create_file' || type === 'update_file') {
                    try {
                        if (type === 'create_file') {
                            // Dry-run: apply diff to empty content for new file
                            applyDiff('', diff);
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
                        // Diff validation failed - auto-approve (skip user prompt) and fail in execute
                        // This prevents breaking the stream while still rejecting the invalid patch
                        loggingService.error(
                            'apply_patch validation failed - will fail in execute',
                            {
                                type,
                                path: filePath,
                                error: diffError?.message || String(diffError),
                            },
                        );
                        // Return false to auto-approve - execute will handle the error gracefully
                        return false;
                    }
                }

                // Deletions ALWAYS require approval per policy
                // if (type === 'delete_file') {
                //     loggingService.security('apply_patch needsApproval: delete requires approval', {
                //         mode,
                //         type,
                //         path: filePath,
                //     });
                //     return true;
                // }

                // Resolve and ensure target within workspace
                const workspaceRoot = executionContext?.getCwd() || process.cwd();
                let targetPath: string;
                try {
                    targetPath = resolveWorkspacePath(filePath, workspaceRoot);
                } catch (e: any) {
                    // Outside workspace => require approval
                    loggingService.security(
                        'apply_patch needsApproval: outside workspace',
                        {
                            editMode,
                            type,
                            path: filePath,
                            error: e?.message || String(e),
                        },
                    );
                    return true;
                }

                const insideCwd = targetPath.startsWith(
                    workspaceRoot + path.sep,
                );

                // In edit mode, auto-approve create/update within cwd
                if (
                    editMode &&
                    insideCwd &&
                    (type === 'create_file' || type === 'update_file')
                ) {
                    loggingService.security(
                        'apply_patch needsApproval: auto-approved in edit mode',
                        {
                            editMode,
                            type,
                            path: filePath,
                            targetPath,
                        },
                    );
                    return false;
                }

                // Otherwise, require approval (default behavior)
                loggingService.security(
                    'apply_patch needsApproval: approval required',
                    {
                        editMode,
                        type,
                        path: filePath,
                        targetPath,
                        insideCwd,
                    },
                );
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
            const enableFileLogging = settingsService.get<boolean>(
                'tools.logFileOperations',
            );
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

            const mkdirFn = async (p: string) => {
                if (isRemote && sshService) return sshService.mkdir(p);
                return mkdir(p, { recursive: true });
            };

            try {
                const {type, path: filePath, diff} = params;
                const targetPath = resolveWorkspacePath(filePath, cwd);

                if (enableFileLogging) {
                    loggingService.info(`File operation started: ${type}`, {
                        path: filePath,
                        targetPath,
                    });
                }

                // Re-validate patch before executing
                if (type === 'create_file' || type === 'update_file') {
                    try {
                        if (type === 'create_file') {
                            // Test applying diff to empty content
                            applyDiff('', diff);
                        } else {
                            // Test applying diff to existing file content
                            const original = await readFileFn(targetPath);
                            applyDiff(original, diff);
                        }
                    } catch (validationError: any) {
                        loggingService.error(
                            'Patch validation failed in execute',
                            {
                                type,
                                path: filePath,
                                error:
                                    validationError?.message ||
                                    String(validationError),
                            },
                        );
                        return JSON.stringify({
                            output: [
                                {
                                    success: false,
                                    error: `Invalid patch: ${
                                        validationError?.message ||
                                        String(validationError)
                                    }. Please check the file path and diff format.`,
                                },
                            ],
                        });
                    }
                }

                switch (type) {
                    case 'create_file': {
                        // Ensure parent directory exists
                        await mkdirFn(path.dirname(targetPath));

                        // Apply diff to empty content for new file
                        const content = applyDiff('', diff);
                        await writeFileFn(targetPath, content);

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
                            output: [
                                {
                                    success: true,
                                    operation: 'create_file',
                                    path: filePath,
                                    message: `Created ${filePath}`,
                                },
                            ],
                        });
                    }

                    case 'update_file': {
                        // Read existing file
                        let original: string;
                        try {
                            original = await readFileFn(targetPath);
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
                                    output: [
                                        {
                                            success: false,
                                            error: `Cannot update missing file: ${filePath}`,
                                        },
                                    ],
                                });
                            }

                            throw error;
                        }

                        // Apply diff to existing content
                        const patched = applyDiff(original, diff);
                        await writeFileFn(targetPath, patched);

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
                            output: [
                                {
                                    success: true,
                                    operation: 'update_file',
                                    path: filePath,
                                    message: `Updated ${filePath}`,
                                },
                            ],
                        });
                    }

                    // case 'delete_file': {
                    //     await rm(targetPath, {force: true});

                    //     if (enableFileLogging) {
                    //         try {
                    //             loggingService.info('File deleted', {
                    //                 path: filePath,
                    //                 targetPath,
                    //             });
                    //         } catch (error) {
                    //             // Ignore logging errors to prevent operation failure
                    //         }
                    //     }

                    //     return JSON.stringify({
                    //         output: [
                    //             {
                    //                 success: true,
                    //                 operation: 'delete_file',
                    //                 path: filePath,
                    //                 message: `Deleted ${filePath}`,
                    //             },
                    //         ],
                    //     });
                    // }

                    default: {
                        return JSON.stringify({
                            output: [
                                {
                                    success: false,
                                    error: `Unknown operation type: ${type}`,
                                },
                            ],
                        });
                    }
                }
            } catch (error: any) {
                if (enableFileLogging) {
                    loggingService.error('File operation failed', {
                        type: params.type,
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
        formatCommandMessage: formatApplyPatchCommandMessage,
    };
}
