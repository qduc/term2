import { z } from 'zod';
import process from 'process';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { relaxedNumber } from './utils.js';
import { classifyCommandDetailed, SafetyStatus } from '../utils/command-safety/index.js';
import { logValidationError as logValidationErrorUtil } from '../utils/command-logger.js';
import { executeShellCommand } from '../utils/execute-shell.js';
import {
  trimOutput,
  setTrimConfig,
  getTrimConfig,
  DEFAULT_TRIM_CONFIG,
  type OutputTrimConfig,
} from '../utils/output-trim.js';
import type { ToolDefinition, FormatCommandMessage } from './types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import {
  coerceToText,
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
} from './format-helpers.js';
import { ExecutionContext } from '../services/execution-context.js';
import { ensureRtkInstalled, isRtkSupportedCommand, wrapWithRtk } from '../services/rtk-service.js';

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
      'Optional maximum output length in characters for each command. Outputs exceeding this length will be trimmed. Defaults to 10000 characters if not specified.',
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

type ShellCommandClassification = {
  optimizedCommand: string;
  classification: ReturnType<typeof classifyCommandDetailed>;
};

type SandboxSessionLike = {
  exec: (args: { cmd: string; workdir?: string; yieldTimeMs?: number }) => Promise<{
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    sessionId?: number;
  }>;
  stop?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  delete?: () => Promise<void>;
  close?: () => Promise<void>;
};

function classifyShellCommand(command: string, cwd: string, log: ILoggingService): ShellCommandClassification {
  const optimizedCommand = stripRedundantCd(command, cwd);
  return {
    optimizedCommand,
    classification: classifyCommandDetailed(optimizedCommand, log),
  };
}

function isSandboxRequired(classification: ReturnType<typeof classifyCommandDetailed>): boolean {
  return classification.execution?.requiresSandbox === true;
}

function canAutoAllowSandboxedCommand(
  classification: ReturnType<typeof classifyCommandDetailed>,
  sandboxAvailable: boolean,
  autoAllowSandboxedCommands: boolean,
): boolean {
  return (
    classification.status === SafetyStatus.YELLOW &&
    isSandboxRequired(classification) &&
    sandboxAvailable &&
    autoAllowSandboxedCommands
  );
}

async function stopSandboxProcess(session: SandboxSessionLike): Promise<void> {
  const stopOperations: Array<() => Promise<void>> = [];

  if (session.stop) {
    stopOperations.push(() => session.stop!());
  }
  if (session.shutdown) {
    stopOperations.push(() => session.shutdown!());
  }
  if (session.delete) {
    stopOperations.push(() => session.delete!());
  }
  if (session.close) {
    stopOperations.push(() => session.close!());
  }

  for (const stop of stopOperations) {
    try {
      await stop();
      return;
    } catch {
      // Try the next cleanup hook.
    }
  }
}

async function executeSandboxShellCommand(
  session: SandboxSessionLike,
  command: string,
  options: {
    workdir: string;
    timeout?: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const signal = options.signal;
  const execPromise = session.exec({
    cmd: command,
    workdir: options.workdir,
    yieldTimeMs: options.timeout,
  });

  let abortListener: (() => void) | undefined;

  const result = signal
    ? await Promise.race([
        execPromise,
        new Promise<{ aborted: true }>((resolve) => {
          if (signal.aborted) {
            void stopSandboxProcess(session).finally(() => resolve({ aborted: true }));
            return;
          }

          abortListener = () => {
            void stopSandboxProcess(session).finally(() => resolve({ aborted: true }));
          };
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      ])
    : await execPromise;

  if (abortListener) {
    signal?.removeEventListener('abort', abortListener);
  }

  if ('aborted' in result) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
    };
  }

  const timedOut = result.sessionId !== undefined;
  if (timedOut) {
    await stopSandboxProcess(session);
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? null,
    timedOut,
  };
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
    }),
  ];
};

export function createShellToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  rtkInstaller?: typeof ensureRtkInstalled;
  orchestratorMode?: boolean;
}): ToolDefinition<ShellToolParams> {
  const {
    loggingService,
    settingsService,
    executionContext,
    rtkInstaller = ensureRtkInstalled,
    orchestratorMode = false,
  } = deps;

  // Create command logger function with dependencies
  const logValidationError = (message: string) => logValidationErrorUtil(settingsService, message);
  let sandboxExecutionChain: Promise<void> = Promise.resolve();

  const runSandboxSequentially = async <T>(task: () => Promise<T>): Promise<T> => {
    const run = sandboxExecutionChain.then(task, task);
    sandboxExecutionChain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  return {
    name: 'shell',
    description: orchestratorMode
      ? "Execute a single shell command to verify state (e.g., run tests, check git status, or verify a subagent's work). For performing complex operations or making changes, prefer delegating to a `worker` subagent via `run_subagent`."
      : 'Execute a single shell command. Use this to run a terminal command.',
    parameters: shellParametersSchema,
    needsApproval: async (params) => {
      try {
        const cwd = executionContext?.getCwd() || process.cwd();
        const { optimizedCommand, classification } = classifyShellCommand(params.command, cwd, loggingService);
        const sandboxAvailable = executionContext?.isSandboxAvailable() ?? false;
        const autoAllowSandboxedCommands = settingsService.get<boolean>('shell.autoAllowSandboxedCommands');
        const autoAllowed = canAutoAllowSandboxedCommand(classification, sandboxAvailable, autoAllowSandboxedCommands);
        const requiresApproval = classification.status !== SafetyStatus.GREEN && !autoAllowed;

        // Log security event for all shell commands with dangerous flag
        loggingService.security('Shell tool needsApproval check', {
          commands: [params.command.substring(0, 100)], // Truncate for safety
          optimizedCommand: optimizedCommand.substring(0, 100),
          status: classification.status,
          reasons: classification.reasons,
          requiresSandbox: isSandboxRequired(classification),
          sandboxAvailable,
          autoAllowSandboxedCommands,
          requiresApproval,
        });

        return requiresApproval;
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
      const { optimizedCommand, classification } = classifyShellCommand(command, cwd, loggingService);
      const sandboxRequired = isSandboxRequired(classification);
      const sshService = executionContext?.getSSHService();
      const sandboxAvailable = executionContext?.isSandboxAvailable() ?? false;

      if (settingsService.get<boolean>('app.planMode') && classification.status !== SafetyStatus.GREEN) {
        return `Error: plan mode is read-only. Command not executed: ${command}`;
      }
      const previousCorrelationId = loggingService.getCorrelationId();
      const correlationId = randomUUID();

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
          commands: [optimizedCommand],
          timeout,
          workingDirectory: cwd,
          maxOutputLength,
          status: classification.status,
          reasons: classification.reasons,
          requiresSandbox: sandboxRequired,
          route: sandboxRequired && !sshService ? 'sandbox' : 'host',
        });

        if (optimizedCommand !== command) {
          loggingService.debug('Stripped redundant cd command', {
            original: command,
            optimized: optimizedCommand,
            cwd,
          });
        }

        let result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

        if (sandboxRequired && !sshService) {
          if (!executionContext || !sandboxAvailable) {
            return `Error: sandboxed shell command requires a local sandbox session, but none is available. Command not executed: ${command}`;
          }

          const sandboxWorkdir = executionContext.getSandboxWorkdir();
          try {
            result = await runSandboxSequentially(async () => {
              const session = await executionContext.getOrCreateSandboxSession();
              return await executeSandboxShellCommand(session, optimizedCommand, {
                workdir: sandboxWorkdir,
                timeout,
                signal: (details as { signal?: AbortSignal } | undefined)?.signal,
              });
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            loggingService.error('Sandbox shell command execution error', {
              error: errorMessage,
              command: optimizedCommand.substring(0, 100),
            });
            return `Error: failed to execute sandboxed shell command: ${errorMessage}`;
          }
        } else {
          let commandToRun = optimizedCommand;
          if (
            !sshService &&
            settingsService.get<boolean>('shell.useRtkCompression') &&
            isRtkSupportedCommand(optimizedCommand) &&
            !sandboxRequired
          ) {
            const rtkPath = await rtkInstaller({ loggingService });
            if (rtkPath) {
              commandToRun = wrapWithRtk(optimizedCommand, rtkPath);
              loggingService.debug('Wrapped command with rtk', { rtkPath, original: optimizedCommand });
            }
          }

          result = await executeShellCommand(commandToRun, {
            cwd,
            timeout,
            maxBuffer: 1024 * 1024, // 1MB max buffer
            signal: (details as { signal?: AbortSignal } | undefined)?.signal,
            sshService,
          });
        }

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

        const stdoutTrimmed = trimOutput(stdout, undefined, maxOutputLength).trimEnd();
        const stderrTrimmed = trimOutput(stderr, undefined, maxOutputLength).trimEnd();
        const combinedOutput = [stdoutTrimmed, stderrTrimmed].filter(Boolean).join('\n').trimEnd();

        const statusLine = outcome.type === 'timeout' ? 'timeout' : `exit ${outcome.exitCode ?? 'null'}`;

        // Add helpful note when command succeeds with no output
        const emptyOutputNote =
          combinedOutput === '' && outcome.type === 'exit' && outcome.exitCode === 0 ? '(No output)' : '';

        return [statusLine, combinedOutput, emptyOutputNote].filter(Boolean).join('\n');
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
