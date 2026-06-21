import { z } from 'zod';
import process from 'process';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { relaxedNumber } from '../utils.js';
import { validateCommandSafety } from '../../utils/shell/command-safety/index.js';
import { logValidationError as logValidationErrorUtil } from '../../utils/shell/command-logger.js';
import { executeShellCommand } from '../../utils/shell/execute-shell.js';
import {
  setTrimConfig,
  getTrimConfig,
  DEFAULT_TRIM_CONFIG,
  type OutputTrimConfig,
} from '../../utils/output/output-trim.js';
import { formatShellExecutionOutput } from '../../utils/shell/shell-output.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import type { ILoggingService, ISettingsService } from '../../services/service-interfaces.js';
import {
  coerceToText,
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
} from '../format-helpers.js';
import { ExecutionContext } from '../../services/execution-context.js';
import { ensureRtkInstalled, isRtkSupportedCommand, wrapWithRtk } from '../../services/rtk-service.js';

const shellParametersSchema = z.object({
  command: z.string().min(1).describe('Single shell command to execute.'),
  timeout_ms: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Optional timeout in milliseconds for each command. Defaults to 120000 ms (2 minutes) if not specified.'),
  max_output_length: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe(
      'Optional maximum output length in characters for each command. Outputs exceeding this length will be trimmed. Defaults to 40000 characters if not specified.',
    ),
});

export type ShellToolParams = z.infer<typeof shellParametersSchema>;

// Re-export trim utilities for backwards compatibility
export { setTrimConfig, getTrimConfig, DEFAULT_TRIM_CONFIG, type OutputTrimConfig };

interface ShellCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  outcome: { type: 'exit'; exitCode: number | null } | { type: 'timeout' };
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

/**
 * Strip RTK's "No hook installed" warning from stderr output.
 * The rtk binary prints this banner to stderr when its git hook is not installed.
 */
function stripRtkWarning(text: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .filter((line) => !line.includes('[rtk] /!\\ No hook installed'))
    .join('\n');
}

function isMutatingCommand(command: string, cwd: string, log: ILoggingService): boolean {
  return validateCommandSafety(stripRedundantCd(command, cwd), log); // true = YELLOW/RED
}

const coerceCommandText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => coerceToText(part))
      .filter(Boolean)
      .join('\n');
  }

  return coerceToText(value);
};

export const formatShellCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const command = (() => {
    if (typeof args === 'string') {
      return args;
    }

    const directCommand = coerceCommandText((args as any)?.command);
    if (directCommand) {
      return directCommand;
    }

    const commandsValue = (args as any)?.commands;
    if (typeof commandsValue === 'string') {
      return commandsValue;
    }

    if (Array.isArray(commandsValue)) {
      const commands = commandsValue
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'command' in entry
            ? coerceCommandText((entry as any).command)
            : coerceCommandText(entry),
        )
        .filter(Boolean)
        .join('\n');

      if (commands) {
        return commands;
      }
    }

    return 'Unknown command';
  })();

  const outputText = getOutputText(item);

  // Check if this is an error message (doesn't start with expected status formats)
  const firstLine = outputText.split('\n')[0]?.trim() || '';
  const isErrorMessage =
    firstLine.includes('error') ||
    firstLine.includes('Error') ||
    firstLine.includes('failed') ||
    firstLine.includes('Failed') ||
    (!firstLine.startsWith('exit ') && firstLine !== 'timeout' && outputText && !outputText.includes('\n'));

  let output: string;
  let success: boolean | undefined;
  let failureReason: string | undefined;

  if (isErrorMessage && !firstLine.startsWith('exit ') && firstLine !== 'timeout') {
    // For error messages, use the entire output
    output = outputText || 'No output';
    success = false;
    failureReason = 'error';
  } else {
    // For normal shell output, parse status line and body
    const [statusLineRaw, ...bodyLines] = outputText.split('\n');
    const statusLine = (statusLineRaw ?? '').trim();
    const bodyText = bodyLines.join('\n').trim();
    output = bodyText || 'No output';

    if (statusLine === 'timeout') {
      success = false;
      failureReason = 'timeout';
    } else if (statusLine.startsWith('exit ')) {
      const parsedExitCode = Number(statusLine.slice(5).trim());
      success = Number.isFinite(parsedExitCode) ? parsedExitCode === 0 : undefined;
    }
  }

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      failureReason,
      toolName: 'shell',
    }),
  ];
};

const SHELL_DESCRIPTION =
  'Execute a single shell command. Use this to run tests, check git status, install dependencies, inspect system state, or run one-off scripts. ' +
  'Long output is saved to a file; ' +
  'Do NOT write multi-line inline scripts, it is prone to escaping mistakes. Use create_file to write the script then use this tool to run it. ' +
  'Do NOT use this for complex multi-step edits or broad codebase exploration; use run_subagent instead.';
const SHELL_DESCRIPTION_ORCHESTRATOR =
  "Execute a single shell command to verify state (e.g., run tests, check git status, or verify a subagent's work). Long output is saved to a file; " +
  'For performing complex operations or making changes, prefer delegating to a `worker` subagent via `run_subagent`.';

export function createShellToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  rtkInstaller?: typeof ensureRtkInstalled;
  executeShellCommandImpl?: typeof executeShellCommand;
  orchestratorMode?: boolean;
}): ToolDefinition<ShellToolParams> {
  const {
    loggingService,
    settingsService,
    executionContext,
    rtkInstaller = ensureRtkInstalled,
    executeShellCommandImpl = executeShellCommand,
    orchestratorMode = false,
  } = deps;

  // Create command logger function with dependencies
  const logValidationError = (message: string) => logValidationErrorUtil(settingsService, message);

  const shellDescription = orchestratorMode ? SHELL_DESCRIPTION_ORCHESTRATOR : SHELL_DESCRIPTION;

  return {
    name: 'shell',
    description: shellDescription,
    parameters: shellParametersSchema,
    needsApproval: async (params) => {
      try {
        const cwd = executionContext?.getCwd() || process.cwd();
        const isDangerous = isMutatingCommand(params.command, cwd, loggingService);

        // Log security event for all shell commands with dangerous flag
        loggingService.security('Shell tool needsApproval check', {
          commands: [params.command.substring(0, 100)], // Truncate for safety
          optimizedCommand: stripRedundantCd(params.command, cwd).substring(0, 100),
          isDangerous,
        });

        return isDangerous;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logValidationError(`Validation failed: ${errorMessage}`);
        loggingService.error('Shell tool validation error', {
          error: errorMessage,
          commands: [params.command.substring(0, 100)],
        });
        return true; // fail-safe: require approval on validation errors
      }
    },
    execute: async ({ command, timeout_ms, max_output_length }, _context, details) => {
      const cwd = executionContext?.getCwd() || process.cwd();
      if (settingsService.get<boolean>('app.planMode') && isMutatingCommand(command, cwd, loggingService)) {
        return `Error: plan mode is read-only. Command not executed: ${command}`;
      }
      const sshService = executionContext?.getSSHService();
      const previousCorrelationId = loggingService.getCorrelationId();
      const correlationId = randomUUID();
      const startedAt = Date.now();

      // Set correlation ID for tracking related operations
      loggingService.setCorrelationId(correlationId);

      try {
        // Use provided values or settings defaults or hardcoded defaults
        const timeoutValue = timeout_ms ?? settingsService.get('shell.timeout');
        const timeout = timeoutValue != null ? timeoutValue : undefined;
        const maxOutputLengthValue = max_output_length ?? settingsService.get('shell.maxOutputChars');
        const maxOutputLength = maxOutputLengthValue != null ? maxOutputLengthValue : undefined;

        loggingService.debug('Shell command execution started', {
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

        let commandToRun = optimizedCommand;
        if (
          !sshService &&
          settingsService.get<boolean>('shell.useRtkCompression') &&
          isRtkSupportedCommand(optimizedCommand)
        ) {
          const rtkPath = await rtkInstaller({ loggingService });
          if (rtkPath) {
            commandToRun = wrapWithRtk(optimizedCommand, rtkPath);
            loggingService.debug('Wrapped command with rtk', { rtkPath, original: optimizedCommand });
          }
        }

        const result = await executeShellCommandImpl(commandToRun, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024, // 1MB max buffer
          signal: (details as { signal?: AbortSignal } | undefined)?.signal,
          sshService,
        });

        const stdout = result.stdout ?? '';
        const stderr = stripRtkWarning(result.stderr ?? '');
        const exitCode = result.exitCode ?? null;
        const outcome: ShellCommandResult['outcome'] = result.timedOut
          ? { type: 'timeout' }
          : { type: 'exit', exitCode };

        if (result.timedOut) {
          loggingService.warn('Shell command timeout', {
            command: optimizedCommand.substring(0, 100),
            timeout,
          });
        } else if (exitCode === 0) {
          loggingService.debug('Shell command executed successfully', {
            command: optimizedCommand.substring(0, 100),
            exitCode: 0,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
          });
        } else {
          loggingService.debug('Shell command execution failed', {
            command: optimizedCommand.substring(0, 100),
            exitCode,
            stderrLength: stderr.length,
          });
        }

        loggingService.debug('Shell command execution completed', {
          commandCount: 1,
          successCount: outcome.type === 'exit' && outcome.exitCode === 0 ? 1 : 0,
          failureCount: outcome.type === 'exit' && outcome.exitCode !== 0 ? 1 : 0,
          timeoutCount: outcome.type === 'timeout' ? 1 : 0,
        });

        const formattedOutput = await formatShellExecutionOutput({
          command: optimizedCommand,
          cwd,
          stdout,
          stderr,
          exitCode,
          timedOut: outcome.type === 'timeout',
          maxOutputLength,
          durationMs: Date.now() - startedAt,
        });

        return formattedOutput.text;
      } finally {
        if (previousCorrelationId) {
          loggingService.setCorrelationId(previousCorrelationId);
        } else {
          loggingService.clearCorrelationId();
        }
      }
    },
    formatCommandMessage: formatShellCommandMessage,
  };
}
