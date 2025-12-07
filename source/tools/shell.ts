import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import process from 'process';
import {randomUUID} from 'node:crypto';
import {validateCommandSafety} from '../utils/command-safety.js';
import {logValidationError} from '../utils/command-logger.js';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';
import {
    trimOutput,
    setTrimConfig,
    getTrimConfig,
    DEFAULT_TRIM_CONFIG,
    type OutputTrimConfig,
} from '../utils/output-trim.js';
import type {ToolDefinition} from './types.js';

const execPromise = util.promisify(exec);

const shellParametersSchema = z.object({
    commands: z
        .array(z.string().min(1))
        .min(1, 'At least one command required')
        .max(3, 'The maximum number of parallel commands is 3')
        .describe(
            'Array of shell commands to execute sequentially, one command per entry.',
        ),
    timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(DEFAULT_TRIM_CONFIG.maxCharacters)
        .describe(
            'Optional timeout in milliseconds for each command. Defaults to 120000 ms (2 minutes) if not specified.',
        ),
    max_output_length: z
        .number()
        .int()
        .positive()
        .optional()
        .default(DEFAULT_TRIM_CONFIG.maxCharacters)
        .describe(
            'Optional maximum output length in characters for each command. Outputs exceeding this length will be trimmed. Defaults to 10000 characters if not specified.',
        ),
    needsApproval: z.boolean(),
});

export type ShellToolParams = z.infer<typeof shellParametersSchema>;

// Re-export trim utilities for backwards compatibility
export {
    setTrimConfig,
    getTrimConfig,
    DEFAULT_TRIM_CONFIG,
    type OutputTrimConfig,
};

interface ShellCommandResult {
    command: string;
    stdout: string;
    stderr: string;
    outcome: {type: 'exit'; exitCode: number | null} | {type: 'timeout'};
}

/**
 * Custom shell tool that follows the same approval pattern as the bash tool.
 * This tool accepts an array of commands and executes them sequentially.
 *
 * Unlike the built-in shellTool from @openai/agents, this implementation:
 * 1. Uses the same needsApproval/execute pattern as other custom tools
 * 2. Works correctly with the async UI approval flow (interruption → user decision → continuation)
 * 3. Returns results in a format compatible with the shell tool output format
 * 4. Includes command safety validation like the bash tool
 */
export const shellToolDefinition: ToolDefinition<ShellToolParams> = {
    name: 'shell',
    description:
        'Execute shell commands. Use this to run terminal commands. The commands will be executed sequentially. Assert the safety of the commands; if they do not change system state or read sensitive data, set needsApproval to false. Otherwise set needsApproval to true and wait for user approval before executing.',
    parameters: shellParametersSchema,
    needsApproval: async params => {
        try {
            const isDangerous =
                params.needsApproval ||
                params.commands.some(cmd => validateCommandSafety(cmd));

            // Log security event for all shell commands with dangerous flag
            loggingService.security('Shell tool needsApproval check', {
                commands: params.commands.map(cmd => cmd.substring(0, 100)), // Truncate for safety
                isDangerous,
                needsApprovalRequested: params.needsApproval,
            });

            return isDangerous;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            logValidationError(`Validation failed: ${errorMessage}`);
            loggingService.error('Shell tool validation error', {
                error: errorMessage,
                commands: params.commands.map(cmd => cmd.substring(0, 100)),
            });
            return true; // fail-safe: require approval on validation errors
        }
    },
    execute: async ({commands, timeout_ms, max_output_length}) => {
        const cwd = process.cwd();
        const output: ShellCommandResult[] = [];
        const correlationId = randomUUID();

        // Set correlation ID for tracking related operations
        loggingService.setCorrelationId(correlationId);

        try {
            // Use provided values or settings defaults or hardcoded defaults
            const timeout = timeout_ms ?? settingsService.get('shell.timeout');
            const maxOutputLength =
                max_output_length ??
                settingsService.get('shell.maxOutputChars');

            loggingService.info('Shell command execution started', {
                commandCount: commands.length,
                commands,
                timeout,
                workingDirectory: cwd,
                maxOutputLength,
            });

            for (const command of commands) {
                let stdout = '';
                let stderr = '';
                let exitCode: number | null = 0;
                let outcome: ShellCommandResult['outcome'] = {
                    type: 'exit',
                    exitCode: 0,
                };

                try {
                    const result = await execPromise(command, {
                        cwd,
                        timeout,
                        maxBuffer: 1024 * 1024, // 1MB max buffer
                    });
                    stdout = result.stdout;
                    stderr = result.stderr;

                    loggingService.debug(
                        'Shell command executed successfully',
                        {
                            command: command.substring(0, 100),
                            exitCode: 0,
                            stdoutLength: stdout.length,
                            stderrLength: stderr.length,
                        },
                    );
                } catch (error: any) {
                    exitCode =
                        typeof error?.code === 'number' ? error.code : null;
                    stdout = error?.stdout ?? '';
                    stderr = error?.stderr ?? '';
                    outcome =
                        error?.killed || error?.signal === 'SIGTERM'
                            ? {type: 'timeout'}
                            : {type: 'exit', exitCode};

                    if (outcome.type === 'timeout') {
                        loggingService.warn('Shell command timeout', {
                            command: command.substring(0, 100),
                            timeout,
                        });
                    } else {
                        loggingService.debug('Shell command execution failed', {
                            command: command.substring(0, 100),
                            exitCode,
                            errorMessage: error?.message ?? String(error),
                            stderrLength: stderr.length,
                        });
                    }
                }

                output.push({
                    command,
                    stdout: trimOutput(stdout, undefined, maxOutputLength),
                    stderr: trimOutput(stderr, undefined, maxOutputLength),
                    outcome,
                });
                if (outcome.type === 'timeout') {
                    break;
                }
            }

            loggingService.info('Shell command execution completed', {
                commandCount: commands.length,
                successCount: output.filter(
                    cmd =>
                        cmd.outcome.type === 'exit' &&
                        cmd.outcome.exitCode === 0,
                ).length,
                failureCount: output.filter(
                    cmd =>
                        cmd.outcome.type === 'exit' &&
                        cmd.outcome.exitCode !== 0,
                ).length,
                timeoutCount: output.filter(
                    cmd => cmd.outcome.type === 'timeout',
                ).length,
            });

            return JSON.stringify({
                output,
                providerData: {
                    working_directory: cwd,
                },
            });
        } finally {
            // Always clear correlation ID
            loggingService.clearCorrelationId();
        }
    },
};
