import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import process from 'process';
import path from 'path';
import {randomUUID} from 'node:crypto';
import {validateCommandSafety} from '../utils/command-safety/index.js';
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
    command: z
        .string()
        .min(1)
        .describe('Single shell command to execute.'),
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
 * Strip redundant 'cd <path> &&' prefix if it targets the current working directory
 */
function stripRedundantCd(command: string, cwd: string): string {
    const cdPattern = /^cd\s+([^\s&]+)\s+&&\s+(.+)$/;
    const match = command.match(cdPattern);

    if (match) {
        const [, targetPath, restOfCommand] = match;
        // Resolve the target path to absolute
        const absoluteTargetPath = path.resolve(cwd, targetPath);

        // If target path is same as cwd, strip the cd part
        if (absoluteTargetPath === cwd) {
            return restOfCommand;
        }
    }

    return command;
}

export const shellToolDefinition: ToolDefinition<ShellToolParams> = {
    name: 'shell',
    description:
        'Execute a single shell command. Use this to run a terminal command. Assert the safety of the command; if it does not change system state or read sensitive data, set needsApproval to false. Otherwise set needsApproval to true and wait for user approval before executing.',
    parameters: shellParametersSchema,
    needsApproval: async params => {
        try {
            const cwd = process.cwd();
            const optimizedCommand = stripRedundantCd(params.command, cwd);
            const isDangerous = validateCommandSafety(optimizedCommand);

            // Log security event for all shell commands with dangerous flag
            loggingService.security('Shell tool needsApproval check', {
                commands: [params.command.substring(0, 100)], // Truncate for safety
                optimizedCommand: optimizedCommand.substring(0, 100),
                isDangerous,
            });

            return isDangerous;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            logValidationError(`Validation failed: ${errorMessage}`);
            loggingService.error('Shell tool validation error', {
                error: errorMessage,
                commands: [params.command.substring(0, 100)],
            });
            return true; // fail-safe: require approval on validation errors
        }
    },
    execute: async ({command, timeout_ms, max_output_length}) => {
        const cwd = process.cwd();
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
                commandCount: 1,
                commands: [command],
                timeout,
                workingDirectory: cwd,
                maxOutputLength,
            });

            // Strip redundant 'cd <path> &&' if it targets the current directory
            const optimizedCommand = stripRedundantCd(command, cwd);
            if (optimizedCommand !== command) {
                loggingService.debug('Stripped redundant cd command', {
                    original: command,
                    optimized: optimizedCommand,
                    cwd,
                });
            }
            let stdout = '';
            let stderr = '';
            let exitCode: number | null = 0;
            let outcome: ShellCommandResult['outcome'] = {
                type: 'exit',
                exitCode: 0,
            };

            try {
                const result = await execPromise(optimizedCommand, {
                    cwd,
                    timeout,
                    maxBuffer: 1024 * 1024, // 1MB max buffer
                });
                stdout = result.stdout;
                stderr = result.stderr;

                loggingService.debug('Shell command executed successfully', {
                    command: optimizedCommand.substring(0, 100),
                    exitCode: 0,
                    stdoutLength: stdout.length,
                    stderrLength: stderr.length,
                });
            } catch (error: any) {
                exitCode = typeof error?.code === 'number' ? error.code : null;
                stdout = error?.stdout ?? '';
                stderr = error?.stderr ?? '';
                outcome =
                    error?.killed || error?.signal === 'SIGTERM'
                        ? {type: 'timeout'}
                        : {type: 'exit', exitCode};

                if (outcome.type === 'timeout') {
                    loggingService.warn('Shell command timeout', {
                        command: optimizedCommand.substring(0, 100),
                        timeout,
                    });
                } else {
                    loggingService.debug('Shell command execution failed', {
                        command: optimizedCommand.substring(0, 100),
                        exitCode,
                        errorMessage: error?.message ?? String(error),
                        stderrLength: stderr.length,
                    });
                }
            }

            loggingService.info('Shell command execution completed', {
                commandCount: 1,
                successCount:
                    outcome.type === 'exit' && outcome.exitCode === 0 ? 1 : 0,
                failureCount:
                    outcome.type === 'exit' && outcome.exitCode !== 0 ? 1 : 0,
                timeoutCount: outcome.type === 'timeout' ? 1 : 0,
            });

            const stdoutTrimmed = trimOutput(
                stdout,
                undefined,
                maxOutputLength,
            ).trimEnd();
            const stderrTrimmed = trimOutput(
                stderr,
                undefined,
                maxOutputLength,
            ).trimEnd();
            const combinedOutput = [stdoutTrimmed, stderrTrimmed]
                .filter(Boolean)
                .join('\n')
                .trimEnd();

            const statusLine =
                outcome.type === 'timeout'
                    ? 'timeout'
                    : `exit ${outcome.exitCode ?? 'null'}`;

            const noteLine =
                optimizedCommand !== command ? 'note: stripped redundant cd prefix' : '';

            // Add helpful note when command succeeds with no output
            const emptyOutputNote =
                combinedOutput === '' && outcome.type === 'exit' && outcome.exitCode === 0
                    ? 'note: command succeeded with no output'
                    : '';

            return [statusLine, combinedOutput, noteLine, emptyOutputNote]
                .filter(Boolean)
                .join('\n');
        } finally {
            // Always clear correlation ID
            loggingService.clearCorrelationId();
        }
    },
};
