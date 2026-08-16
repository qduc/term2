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
import type { PostExecutePauseDescriptor, SchemaToolDefinition, FormatCommandMessage } from '../types.js';
import type { ILoggingService, ISettingsService } from '../../services/service-interfaces.js';
import {
  coerceToText,
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';
import { ExecutionContext } from '../../services/execution-context.js';
import { ensureRtkInstalled, isRtkSupportedCommand, wrapWithRtk } from '../../services/rtk-service.js';
import { shouldPreferPatchEditingModel } from '../../lib/tool-selection-policy.js';
import { HarnessInvariantError } from '../../lib/harness-invariant-error.js';
import { createSandboxEnvironment } from '../../utils/shell/sandbox/sandbox-env.js';
import {
  SANDBOX_ESCAPE_INSTRUCTION,
  createSandboxRuntimeConfig,
  type SandboxAvailability,
  type ShellSandboxRunner,
} from '../../utils/shell/sandbox/sandbox-policy.js';
import { getDefaultShellSandboxRunner } from '../../utils/shell/sandbox/shell-sandbox-runner.js';
import { DETAILED_DENIED_READ_INSTRUCTION } from '../../utils/shell/sandbox/denied-read-detector.js';
import type { DeniedReadInfo } from '../../utils/shell/sandbox/denied-read-detector.js';
import { getProjectAllowReadStore } from '../../utils/shell/sandbox/denied-read-stores.js';
import { classifySandboxFailure } from '../../utils/shell/sandbox/sandbox-failure-classifier.js';
import {
  createDockerHostControl,
  DOCKER_HOST_CONTROL_RETRY_INSTRUCTION,
  type DockerHostControl,
} from '../../utils/shell/sandbox/docker-host-control.js';
import type { SessionAccessState } from '../../services/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../services/session/nested-tool-compatibility-state.js';
import type { ToolInvocationContext } from '../../services/agent-runtime/tool-invocation-context.js';
import {
  type BackgroundShellJob,
  type BackgroundShellTerminalStatus,
  type BackgroundShellRegistry,
} from '../../services/shell/background-shell-registry.js';
import type {
  BackgroundShellWatches,
  BackgroundShellOutputBundle,
  RegisterShellOutputWatchOptions,
} from '../../services/shell/background-shell-watches.js';

const shellSandboxModeSchema = z.enum(['default', 'unsandboxed']).optional().default('default');

const shellParametersSchema = z.object({
  command: z.string().min(1).describe('Single shell command to execute.'),
  timeout_ms: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe(
      'Optional timeout in milliseconds for each command. Defaults to shell.timeout (foreground) or shell.backgroundTimeout (background) if not specified.',
    ),
  max_output_length: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe(
      'Optional maximum output length in characters for each command. Outputs exceeding this length will be trimmed. Defaults to 40000 characters if not specified.',
    ),
  sandbox: shellSandboxModeSchema.describe(
    'Run mode. default runs inside the sandbox when available. unsandboxed requires explicit user approval.',
  ),
  background: z
    .boolean()
    .optional()
    .default(false)
    .describe('Run locally in the background and return a job ID immediately. Defaults to false.'),
});

// Tool invocation normalizes shape but does not apply Zod defaults before
// execute. Keep the executor input honest: `sandbox` may be absent at runtime.
export type ShellToolParams = Omit<z.infer<typeof shellParametersSchema>, 'sandbox' | 'background'> & {
  sandbox?: 'default' | 'unsandboxed';
  background?: boolean;
};
export type ShellToolDefinition = Omit<
  SchemaToolDefinition<typeof shellParametersSchema>,
  'execute' | 'needsApproval' | 'postExecutePause'
> & {
  needsApproval: (params: ShellToolParams, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: ShellToolParams, context?: unknown, details?: unknown) => Promise<string>;
  postExecutePause?: PostExecutePauseDescriptor<ShellToolParams>;
};

// Re-export trim utilities for backwards compatibility
export { setTrimConfig, getTrimConfig, DEFAULT_TRIM_CONFIG, type OutputTrimConfig };

interface ShellCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  outcome: { type: 'exit'; exitCode: number | null } | { type: 'timeout' };
}

/** The registry keeps the formatted output while retaining the process outcome separately. */
export interface BackgroundShellExecutionResult {
  output: string;
  status: Exclude<BackgroundShellTerminalStatus, 'cancelled'>;
}

const getBackgroundShellJobParameters = z.object({
  job_id: z.string().min(1).describe('The background shell job ID.'),
});

const monitorShellJobParameters = z.object({
  job_id: z.string().min(1).describe('The background shell job ID to monitor.'),
  pattern: z
    .string()
    .optional()
    .describe('Regular expression matched against each complete output line; absent matches any line.'),
  stream: z.enum(['stdout', 'stderr', 'both']).optional().describe('Which output stream to monitor. Defaults to both.'),
  idle_ms: relaxedNumber
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Quiet window in milliseconds that coalesces a burst of matches into one notification. Defaults to 1500.',
    ),
  notify_limit: relaxedNumber
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Maximum number of notifications this watch may deliver before retiring. 0 means unlimited (the watch only retires when its job settles or cancel_shell_monitor is called); defaults to 0.',
    ),
  once: z.boolean().optional().describe('Retire the watch after its first notification (notify_limit 1).'),
});

const cancelShellMonitorParameters = z.object({
  watch_id: z.string().min(1).describe('The watch ID returned by monitor_shell_job.'),
});

export interface BackgroundShellJobToolDefinitions {
  get: SchemaToolDefinition<typeof getBackgroundShellJobParameters>;
  cancel: SchemaToolDefinition<typeof getBackgroundShellJobParameters>;
  monitor?: SchemaToolDefinition<typeof monitorShellJobParameters>;
  cancelMonitor?: SchemaToolDefinition<typeof cancelShellMonitorParameters>;
}

function backgroundShellJobResponse(job: BackgroundShellJob<BackgroundShellExecutionResult>) {
  return {
    jobId: job.id,
    command: job.command,
    status: job.status,
    ...(job.result === undefined ? {} : { output: job.result.output }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}

const ACTIVE_JOB_MESSAGE =
  'This background shell job is still running. End the current turn and wait for its automatic completion notification; do not poll get_shell_job.';

function activeBackgroundShellJobResponse(
  job: BackgroundShellJob<BackgroundShellExecutionResult>,
  output: BackgroundShellOutputBundle | undefined,
) {
  const tail = output?.store.readTail(job.id);
  if (!tail) {
    // The store has no stream for this job (no monitoring layer, or a job
    // that never went through the shell-tool seam): keep the refusal form.
    return {
      status: 'background_job_active',
      jobId: job.id,
      message: ACTIVE_JOB_MESSAGE,
    };
  }
  return {
    status: 'background_job_active',
    jobId: job.id,
    command: job.command,
    tail: tail.text,
    droppedBytes: tail.droppedBytes,
    message: ACTIVE_JOB_MESSAGE,
  };
}

/**
 * Common transcript extraction for the job/monitor control tools: call id,
 * normalized arguments, the parsed tool result, and a string reader.
 */
function backgroundShellToolTranscript(
  item: Parameters<FormatCommandMessage>[0],
  toolCallArgumentsById: Map<string, unknown>,
) {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const toolName = item?.toolName ?? item?.rawItem?.name ?? 'shell_job';
  const outputText = getOutputText(item);
  const response = safeJsonParse(outputText) as Record<string, unknown> | null;
  const readString = (value: unknown): string => (typeof value === 'string' ? value : '');
  return { callId, args, toolName, outputText, response, readString };
}

/**
 * Job control is part of what the model did, so it belongs in the transcript.
 * It also has to be: the UI opens a `running` command row on every
 * `tool_started` and only closes it when a command message arrives for the same
 * callId. A formatter returning `[]` leaves that row running forever, and
 * because a running command is the first thing that cannot render statically,
 * every message behind it stays out of Ink's Static region for the rest of the
 * session.
 */
export const formatBackgroundShellJobCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const { args, toolName, outputText, response, readString } = backgroundShellToolTranscript(
    item,
    toolCallArgumentsById,
  );

  const jobId = readString(response?.jobId) || readString((args as Record<string, unknown>)?.job_id);
  const status = readString(response?.status);
  const jobCommand = readString(response?.command);

  const output = (() => {
    if (!response) {
      return outputText || 'No output';
    }
    if (status === 'not_found') {
      return `Job ${jobId} not found.`;
    }
    // The active-job response carries an instruction aimed at the model
    // ("do not poll"), which is noise in the transcript: show the bounded
    // tail and drop accounting instead of the static refusal string.
    if (status === 'background_job_active') {
      const tail = readString(response?.tail);
      const droppedBytes = typeof response?.droppedBytes === 'number' ? response.droppedBytes : 0;
      const body = [tail, droppedBytes > 0 ? `(${droppedBytes} bytes of earlier output dropped)` : '']
        .filter(Boolean)
        .join('\n');
      return body || 'Still running.';
    }

    const header = jobCommand ? `${status} · ${jobCommand}` : status ? `status: ${status}` : '';
    const body = readString(response.output);
    const error = readString(response.error);
    return [header, body, error].filter(Boolean).join('\n') || outputText || 'No output';
  })();

  return [
    createBaseMessage(item, index, 0, false, {
      command: jobId ? `${toolName} ${jobId}` : toolName,
      output,
      success: status !== 'not_found' && !readString(response?.error),
      toolName,
      toolArgs: args,
    }),
  ];
};

/**
 * Transcript row for `monitor_shell_job`. Renders the returned watchId and the
 * job it is attached to; a later `background_shell_output` notification carries
 * the seq/matchedLines of each firing.
 */
export const formatBackgroundShellMonitorCommandMessage: FormatCommandMessage = (
  item,
  index,
  toolCallArgumentsById,
) => {
  const { args, toolName, outputText, response, readString } = backgroundShellToolTranscript(
    item,
    toolCallArgumentsById,
  );
  const jobId = readString(response?.jobId) || readString((args as Record<string, unknown>)?.job_id);
  const watchId = readString(response?.watchId);
  const status = readString(response?.status);

  const output = (() => {
    if (!response) {
      return outputText || 'No output';
    }
    if (status === 'not_found') {
      return `Job ${jobId} not found.`;
    }
    const error = readString(response?.error);
    if (error) {
      return error;
    }
    if (status === 'monitoring') {
      const seq = typeof response?.seq === 'number' ? ` (firing ${response.seq})` : '';
      const matched = readString(response?.matchedLines);
      return [watchId ? `Monitoring job ${jobId} (watch ${watchId}).${seq}` : `Monitoring job ${jobId}.`, matched]
        .filter(Boolean)
        .join('\n');
    }
    return outputText || 'No output';
  })();

  return [
    createBaseMessage(item, index, 0, false, {
      command: watchId ? `${toolName} ${watchId}` : `${toolName} ${jobId}`,
      output,
      success: status === 'monitoring',
      toolName,
      toolArgs: args,
    }),
  ];
};

/** Transcript row for `cancel_shell_monitor`. */
export const formatBackgroundShellCancelMonitorCommandMessage: FormatCommandMessage = (
  item,
  index,
  toolCallArgumentsById,
) => {
  const { args, toolName, outputText, response, readString } = backgroundShellToolTranscript(
    item,
    toolCallArgumentsById,
  );
  const watchId = readString(response?.watchId) || readString((args as Record<string, unknown>)?.watch_id);
  const status = readString(response?.status);

  const output = (() => {
    if (!response) {
      return outputText || 'No output';
    }
    const error = readString(response?.error);
    if (error) {
      return error;
    }
    if (status === 'not_found') {
      return `Watch ${watchId} not found.`;
    }
    if (status === 'cancelled') {
      return `Stopped monitoring (watch ${watchId}).`;
    }
    return outputText || 'No output';
  })();

  return [
    createBaseMessage(item, index, 0, false, {
      command: watchId ? `${toolName} ${watchId}` : toolName,
      output,
      success: status === 'cancelled',
      toolName,
      toolArgs: args,
    }),
  ];
};

/**
 * Root composition registers these alongside `shell` when it supplies the
 * session-owned registry. Keeping them here makes the model contract and its
 * shell lifecycle use the same job representation.
 *
 * `output` carries the session-owned store + watch layer; when it is absent
 * (legacy callers), the monitor tools are not registered.
 */
export function createBackgroundShellJobToolDefinitions(
  registry: BackgroundShellRegistry<BackgroundShellExecutionResult>,
  output?: BackgroundShellOutputBundle,
): BackgroundShellJobToolDefinitions {
  const definitions: BackgroundShellJobToolDefinitions = {
    get: {
      name: 'get_shell_job',
      description:
        'Get the non-blocking status and bounded output of a background shell job. Do not use this to poll a running job; completion is delivered automatically.',
      parameters: getBackgroundShellJobParameters,
      parallelSafe: true,
      needsApproval: () => false,
      execute: ({ job_id }) => {
        const job = registry.get(job_id);
        if (job?.status === 'running' || job?.status === 'cancelling')
          return JSON.stringify(activeBackgroundShellJobResponse(job, output));
        return JSON.stringify(job ? backgroundShellJobResponse(job) : { jobId: job_id, status: 'not_found' });
      },
      formatCommandMessage: formatBackgroundShellJobCommandMessage,
    },
    cancel: {
      name: 'cancel_shell_job',
      description: 'Request cancellation of a running background shell job without waiting for it to exit.',
      parameters: getBackgroundShellJobParameters,
      needsApproval: () => false,
      execute: ({ job_id }) => {
        const job = registry.get(job_id);
        if (!job) return JSON.stringify({ jobId: job_id, status: 'not_found' });
        registry.cancel(job_id);
        const current = registry.get(job_id);
        return JSON.stringify(backgroundShellJobResponse(current ?? job));
      },
      formatCommandMessage: formatBackgroundShellJobCommandMessage,
    },
  };

  if (output) {
    definitions.monitor = {
      name: 'monitor_shell_job',
      description:
        "Attach a watch to a running background shell job. The watch replays the job's retained output, and each time a complete line in the selected stream matches `pattern` (or any line arrives when `pattern` is absent) and the output has been quiet for `idle_ms`, a `shell_output` notification carrying the matched lines is delivered through the conversation; the job keeps running. Returns a watchId; stop the watch with cancel_shell_monitor. Each notification includes the number of distinct lines coalesced into it (`coalescedCount`) and the inclusive seq range (`seqRange`), so bursts hidden by `idle_ms` are visible.",
      parameters: monitorShellJobParameters,
      needsApproval: () => false,
      execute: ({ job_id, pattern, stream, idle_ms, notify_limit, once }) => {
        const job = registry.get(job_id);
        if (
          !job ||
          output.store.readTail(job_id) === undefined ||
          (job.status !== 'running' && job.status !== 'cancelling')
        ) {
          return JSON.stringify({ jobId: job_id, status: 'not_found' });
        }
        let compiled: RegExp | undefined;
        if (pattern !== undefined) {
          try {
            compiled = new RegExp(pattern);
          } catch (error) {
            return JSON.stringify({
              jobId: job_id,
              status: 'error',
              error: `Invalid monitor pattern: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        const options: RegisterShellOutputWatchOptions = {
          jobId: job_id,
          pattern: compiled,
          stream,
          idleMs: idle_ms,
          notifyLimit: once ? 1 : notify_limit,
          command: job.command,
        };
        const watchId = output.watches.registerWatch(options);
        return JSON.stringify({ watchId, jobId: job_id, status: 'monitoring' });
      },
      formatCommandMessage: formatBackgroundShellMonitorCommandMessage,
    };
    definitions.cancelMonitor = {
      name: 'cancel_shell_monitor',
      description: 'Stop a shell monitor watch so it stops delivering shell_output notifications.',
      parameters: cancelShellMonitorParameters,
      needsApproval: () => false,
      execute: ({ watch_id }) => {
        const cancelled = output.watches.cancelWatch(watch_id);
        return JSON.stringify({ watchId: watch_id, status: cancelled ? 'cancelled' : 'not_found' });
      },
      formatCommandMessage: formatBackgroundShellCancelMonitorCommandMessage,
    };
  }

  return definitions;
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

function getConversationSessionId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const runContext = (context as { context?: unknown }).context;
  if (!runContext || typeof runContext !== 'object') return undefined;
  const sessionId = (runContext as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
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

    const argsRecord =
      args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const directCommand = coerceCommandText(argsRecord.command);
    if (directCommand) {
      return directCommand;
    }

    const commandsValue = argsRecord.commands;
    if (typeof commandsValue === 'string') {
      return commandsValue;
    }

    if (Array.isArray(commandsValue)) {
      const commands = commandsValue
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'command' in entry
            ? coerceCommandText((entry as Record<string, unknown>).command)
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
  const backgroundRequested =
    args !== null && typeof args === 'object' && !Array.isArray(args) && args.background === true;
  const launchAcknowledgement = backgroundRequested
    ? (safeJsonParse(outputText) as { jobId?: unknown; status?: unknown } | null)
    : null;

  if (
    launchAcknowledgement?.status === 'running' &&
    typeof launchAcknowledgement.jobId === 'string' &&
    launchAcknowledgement.jobId.length > 0
  ) {
    return [
      createBaseMessage(item, index, 0, false, {
        command,
        output: `Background job ${launchAcknowledgement.jobId} is running.`,
        success: true,
        toolName: 'shell',
        toolArgs: args,
      }),
    ];
  }

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

const getShellDescription = (searchViaShell: boolean) =>
  'Execute a single shell command. ' +
  'Long output is truncated and the full output is saved to a file; ' +
  (searchViaShell
    ? 'Do NOT use this to write. Use the specialized tools for those tasks. '
    : 'Do NOT use this to read, write or search. Use the specialized tools for those tasks. ') +
  'Do NOT write multi-line inline scripts, it is prone to escaping mistakes. Create a temporary script then use this tool to run it. ' +
  'Do NOT use this for complex multi-step edits or broad codebase exploration; use `run_subagent` instead.';
const SHELL_DESCRIPTION_ORCHESTRATOR =
  'Execute a single shell command. Directly inspect, test, or perform a small clear operation when that is the most efficient path. By default, local shell commands run inside the sandbox when available. Use sandbox: "unsandboxed" only for network or outside-host access; it requires explicit user approval and must be run by the main agent. Long output is truncated, the full output is saved to a file; ' +
  'delegate complex, risky, or separable work when specialization, context compression, or safe parallelism provides meaningful leverage.';

export function createShellToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
  rtkInstaller?: typeof ensureRtkInstalled;
  executeShellCommandImpl?: typeof executeShellCommand;
  shellSandboxRunner?: ShellSandboxRunner;
  dockerHostControlFactory?: () => DockerHostControl;
  sessionId?: string;
  orchestratorMode?: boolean;
  searchViaShell?: boolean;
  /** Root-only: pause denied reads through the application-owned post-execute seam. */
  postExecuteDeniedRead?: boolean;
  /** Root clients receive this handle-owned Docker capability. */
  sessionAccess?: SessionAccessState;
  /** Isolated legacy protocol for nested tools only. */
  nestedCompatibility?: NestedToolCompatibilityState;
  /** Root session-owned lifecycle for local background shell jobs. */
  backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
  /** Root session-owned output store + watch layer for background jobs. */
  backgroundShellWatches?: BackgroundShellWatches;
}): ShellToolDefinition {
  const {
    loggingService,
    settingsService,
    executionContext,
    rtkInstaller = ensureRtkInstalled,
    executeShellCommandImpl = executeShellCommand,
    shellSandboxRunner = getDefaultShellSandboxRunner(),
    dockerHostControlFactory = createDockerHostControl,
    orchestratorMode = false,
    searchViaShell: searchViaShellExplicit,
    postExecuteDeniedRead = false,
    sessionAccess,
    nestedCompatibility,
    backgroundShellRegistry,
    backgroundShellWatches,
  } = deps;
  const deniedReadByCallId = new Map<string, DeniedReadInfo>();
  const overrideByCallId = new Map<string, { extraAllowRead?: string[]; forceUnsandboxed?: boolean }>();
  // Create command logger function with dependencies
  const logValidationError = (message: string) => logValidationErrorUtil(settingsService, message);

  const searchViaShellSetting = settingsService.get('app.searchViaShell') ?? 'auto';
  const resolvedSearchViaShell =
    searchViaShellExplicit ??
    (searchViaShellSetting === 'auto'
      ? (() => {
          const model = settingsService.get('agent.model');
          return model ? shouldPreferPatchEditingModel(model) : false;
        })()
      : searchViaShellSetting === 'on');

  const shellDescription = orchestratorMode
    ? SHELL_DESCRIPTION_ORCHESTRATOR
    : getShellDescription(resolvedSearchViaShell);
  // Read per call: the sandbox can be toggled while a session is running, and a
  // stale value would let needsApproval and execute disagree about Docker.
  const isSandboxEnabled = () => settingsService.get('sandbox.enabled') !== false;

  return {
    name: 'shell',
    description: shellDescription,
    parameters: shellParametersSchema,
    needsApproval: async (params, context) => {
      if (settingsService.get('shell.autoApproveMode') === 'always') {
        loggingService.security('Shell tool needsApproval: auto-approved in YOLO mode', {
          command: typeof params?.command === 'string' ? params.command.substring(0, 100) : String(params?.command),
        });
        return false;
      }
      try {
        if (params.sandbox === 'unsandboxed') {
          return true;
        }

        const cwd = executionContext?.getCwd() || process.cwd();
        const sessionId = getConversationSessionId(context);
        const sandboxEnabled = isSandboxEnabled();
        const dockerHostControlRequested =
          sandboxEnabled &&
          (sessionAccess?.requiresDockerApproval(params.command) ??
            nestedCompatibility?.docker.requiresApproval(sessionId, params.command) ??
            false);
        if (
          dockerHostControlRequested &&
          !(sessionAccess?.hasDockerProject(cwd) ?? nestedCompatibility?.docker.hasProject(cwd) ?? false) &&
          !(
            sessionAccess?.hasDockerSessionGrant(cwd) ??
            (sessionId ? nestedCompatibility?.docker.hasSession(sessionId, cwd) : false) ??
            false
          )
        ) {
          return true;
        }
        const sshService = executionContext?.getSSHService();
        if (!sshService && sandboxEnabled) {
          // If a previous sandboxed run denied a read for this command, require
          // approval so the user can allow/remember the path or escape unsandboxed.
          if (!postExecuteDeniedRead && nestedCompatibility?.deniedReads.peek(params.command)) {
            return true;
          }
          const availability = await shellSandboxRunner.availability();
          if (availability.type === 'available') {
            return false;
          }
          return true;
        }

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
          // params.command may itself be why we're in this catch (e.g. undefined
          // after a malformed tool call), so don't re-dereference it unguarded.
          commands: [typeof params.command === 'string' ? params.command.substring(0, 100) : String(params.command)],
        });
        return true; // fail-safe: require approval on validation errors
      }
    },
    execute: async (
      { command, timeout_ms, max_output_length, sandbox = 'default', background = false },
      _context,
      details,
    ) => {
      const toolCallId = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
      // The application run loop owns turn cancellation on its typed context;
      // SDK details only identify the provider tool call.
      const toolSignal =
        (_context as ToolInvocationContext | undefined)?.signal ??
        (details as { signal?: AbortSignal } | undefined)?.signal;
      const cwd = executionContext?.getCwd() || process.cwd();
      const sessionId = getConversationSessionId(_context);
      const sandboxEnabled = isSandboxEnabled();
      const dockerHostControlRequested =
        sandboxEnabled &&
        (sessionAccess?.requiresDockerApproval(command) ??
          nestedCompatibility?.docker.requiresApproval(sessionId, command) ??
          false);
      const hasDockerGrant =
        dockerHostControlRequested &&
        (sessionAccess?.hasDockerGrant(command, cwd) ??
          (nestedCompatibility
            ? nestedCompatibility.docker.hasProject(cwd) ||
              (sessionId &&
                (nestedCompatibility.docker.hasSession(sessionId, cwd) ||
                  nestedCompatibility.docker.consumeOnce(sessionId, command)))
            : false));
      if (dockerHostControlRequested && !hasDockerGrant) {
        return 'Error: Docker host control requires explicit approval.';
      }
      if (settingsService.get('app.planMode') && isMutatingCommand(command, cwd, loggingService)) {
        return `Error: plan mode is read-only. Command not executed: ${command}`;
      }
      const sshService = executionContext?.getSSHService();
      if (background && !backgroundShellRegistry) {
        return 'Error: Background shell execution is unavailable in this session.';
      }
      if (background && sshService) {
        return 'Error: Background shell execution is only available for local sessions.';
      }
      const previousCorrelationId = loggingService.getCorrelationId();
      const correlationId = randomUUID();
      const startedAt = Date.now();
      let sandboxed = false;
      let dockerHostControl: DockerHostControl | undefined;
      let backgroundCleanupDeferred = false;
      let transferred = false;
      let observedJobId: string | undefined;
      // Background-only monitor seam: set when the background branch opens the
      // job's output stream, so the shared onOutputChunk never touches the
      // store for a foreground lease job.
      let monitoredJobId: string | undefined;
      const ownsCorrelationId = !background;
      let foregroundCorrelationRestored = false;
      const restoreForegroundCorrelation = () => {
        if (!ownsCorrelationId || foregroundCorrelationRestored) return;
        foregroundCorrelationRestored = true;
        if (previousCorrelationId) {
          loggingService.setCorrelationId(previousCorrelationId);
        } else {
          loggingService.clearCorrelationId();
        }
      };

      // The logger correlation ID is process-global. A foreground command owns
      // it for the duration of its await; a background job uses the explicit
      // `correlationId` fields below instead so it cannot contaminate another
      // overlapping command's logs.
      if (ownsCorrelationId) loggingService.setCorrelationId(correlationId);
      const withExecutionCorrelation = (metadata: Record<string, unknown>) =>
        background || transferred ? { ...metadata, correlationId } : metadata;

      try {
        // Use provided values or settings defaults or hardcoded defaults. A
        // background launch uses shell.backgroundTimeout instead of
        // shell.timeout (background jobs may legitimately outlive the
        // foreground budget); an explicit timeout_ms always wins.
        const timeoutValue =
          timeout_ms ?? settingsService.get(background ? 'shell.backgroundTimeout' : 'shell.timeout');
        const timeout = timeoutValue != null ? timeoutValue : undefined;
        const maxOutputLengthValue = max_output_length ?? settingsService.get('shell.maxOutputChars');
        const configuredMaxOutputLength = settingsService.get('shell.maxOutputChars');
        const foregroundMaxOutputLength = maxOutputLengthValue != null ? maxOutputLengthValue : undefined;
        const backgroundMaxOutputLength =
          configuredMaxOutputLength != null
            ? Math.min(foregroundMaxOutputLength ?? configuredMaxOutputLength, configuredMaxOutputLength)
            : foregroundMaxOutputLength;
        const initialMaxOutputLength = background ? backgroundMaxOutputLength : foregroundMaxOutputLength;

        loggingService.debug(
          'Shell command execution started',
          withExecutionCorrelation({
            commandCount: 1,
            commands: [command],
            timeout,
            workingDirectory: cwd,
            maxOutputLength: initialMaxOutputLength,
          }),
        );

        // Strip redundant 'cd <path> &&' if it targets the current directory
        const optimizedCommand = stripRedundantCd(command, cwd);
        if (optimizedCommand !== command) {
          loggingService.debug(
            'Stripped redundant cd command',
            withExecutionCorrelation({ original: command, optimized: optimizedCommand, cwd }),
          );
        }

        let commandToRun = optimizedCommand;
        let sandboxAvailability: SandboxAvailability | undefined;
        if (!sshService && settingsService.get('shell.useRtkCompression') && isRtkSupportedCommand(optimizedCommand)) {
          const rtkPath = await rtkInstaller({ loggingService });
          if (rtkPath) {
            commandToRun = wrapWithRtk(optimizedCommand, rtkPath);
            loggingService.debug(
              'Wrapped command with rtk',
              withExecutionCorrelation({ rtkPath, original: optimizedCommand }),
            );
          }
        }

        // Consume any execution override set by a denied-read approval decision.
        // This is a one-shot override for this single execution only.
        const override =
          postExecuteDeniedRead && typeof toolCallId === 'string'
            ? overrideByCallId.get(toolCallId) ?? null
            : nestedCompatibility?.executionOverrides.consume(command) ?? null;
        if (postExecuteDeniedRead && typeof toolCallId === 'string') overrideByCallId.delete(toolCallId);
        if (override?.forceUnsandboxed) {
          sandbox = 'unsandboxed';
          loggingService.debug(
            'Shell executing unsandboxed by approved override',
            withExecutionCorrelation({ command: optimizedCommand.substring(0, 100) }),
          );
        }
        const extraAllowReadFromOverride = override?.extraAllowRead ?? [];

        if (dockerHostControlRequested) {
          if (sandbox !== 'default' || sshService || !sandboxEnabled) {
            return 'Error: Docker host control requires the default local sandbox.';
          }
          try {
            dockerHostControl = dockerHostControlFactory();
            // The run that uses the approval settles the pending block, so a
            // later run of the same command is judged on its own.
            if (sessionAccess) sessionAccess.consumeDockerDenial(command);
            else nestedCompatibility?.docker.consumeDenial(sessionId, command);
            loggingService.security(
              'Docker host-control capability granted for shell command',
              withExecutionCorrelation({
                command: optimizedCommand.substring(0, 100),
                cwd,
                socketPath: dockerHostControl.socketPath,
              }),
            );
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        if (!sshService && sandbox === 'default' && sandboxEnabled) {
          sandboxAvailability = await shellSandboxRunner.availability();
          if (dockerHostControlRequested && sandboxAvailability.type !== 'available') {
            return 'Error: Docker host control requires an available local sandbox.';
          }
          if (sandboxAvailability.type === 'available') {
            try {
              const projectAllowRead = getProjectAllowReadStore(cwd).load();
              const sandboxConfig = createSandboxRuntimeConfig({
                cwd,
                readPolicy: settingsService.get('sandbox.readPolicy'),
                allowNetworking: settingsService.get('sandbox.allowNetworking') === true,
                dockerSocketPath: dockerHostControl?.socketPath,
                allowReadExtra: [
                  ...(settingsService.get('sandbox.allowReadExtra') ?? []),
                  ...projectAllowRead,
                  ...extraAllowReadFromOverride,
                ],
                onProtectedFiltered: (filtered) => {
                  loggingService.info(
                    'Shell sandbox removed write access to protected paths',
                    withExecutionCorrelation({ filtered, cwd }),
                  );
                },
              });
              const wrapped = await shellSandboxRunner.wrap(commandToRun, {
                cwd,
                config: sandboxConfig,
                signal: toolSignal,
              });
              commandToRun = wrapped.command;
              sandboxed = true;
              if (wrapped.diagnostics?.length) {
                loggingService.debug(
                  'Shell sandbox diagnostics',
                  withExecutionCorrelation({ diagnostics: wrapped.diagnostics }),
                );
              }
            } catch (error) {
              loggingService.warn(
                'Shell sandbox initialization failed; refusing unsandboxed fallback',
                withExecutionCorrelation({ error: error instanceof Error ? error.message : String(error) }),
              );
              return `Error: ${SANDBOX_ESCAPE_INSTRUCTION}`;
            }
          } else {
            loggingService.warn(
              'Shell sandbox unavailable; refusing unsandboxed fallback',
              withExecutionCorrelation({
                availability: sandboxAvailability.type,
                reason: 'reason' in sandboxAvailability ? sandboxAvailability.reason : undefined,
              }),
            );
            return `Error: ${SANDBOX_ESCAPE_INSTRUCTION}`;
          }
        }

        const executePreparedCommand = async (
          signal: AbortSignal | undefined,
        ): Promise<BackgroundShellExecutionResult> => {
          const result = await executeShellCommandImpl(commandToRun, {
            cwd,
            timeout,
            maxBuffer: 1024 * 1024, // 1MB max buffer
            // A long-running monitored background job must survive a full
            // buffer: drop from the head of the retained text instead of
            // killing the child. Foreground keeps the 'kill' default.
            overflow: background ? 'truncate' : 'kill',
            env: sandboxed
              ? createSandboxEnvironment(undefined, {
                  cwd,
                  readPolicy: settingsService.get('sandbox.readPolicy'),
                  dockerHostControl,
                })
              : undefined,
            pauseOnSandboxNetworkApproval: sandboxed,
            signal,
            sshService,
            onOutputChunk: (stream, text) => {
              if (observedJobId) backgroundShellRegistry?.recordOutputChunk(observedJobId);
              // Monitoring is background-only: the store stream is opened only
              // for the background branch, so a foreground lease job is never
              // pushed here. watches.push feeds the store and evaluates the
              // job's watches in one call.
              if (monitoredJobId) backgroundShellWatches?.push(monitoredJobId, stream, text);
            },
          });

          const stdout = result.stdout ?? '';
          const rawStderr = stripRtkWarning(result.stderr ?? '');
          const annotatedStderr = sandboxed
            ? shellSandboxRunner.annotateFailure(optimizedCommand, rawStderr)
            : rawStderr;

          const readPolicy = settingsService.get('sandbox.readPolicy');
          const sandboxFailure = classifySandboxFailure({
            command: optimizedCommand,
            rawStderr,
            annotatedStderr,
            sandboxed,
            readPolicy,
            dockerHostControlActive: Boolean(dockerHostControl),
            exitCode: result.exitCode,
          });

          if (sandboxFailure?.type === 'docker_blocked') {
            // Keyed by the command the model passed, because that is what the
            // approval flow and the retry will present.
            if (sessionAccess) sessionAccess.recordDockerDenial(command);
            else nestedCompatibility?.docker.recordDenial(sessionId, command);
            loggingService.security(
              'Sandbox blocked Docker daemon access; agent retry will prompt for approval',
              withExecutionCorrelation({
                confidence: sandboxFailure.confidence,
                command: command.substring(0, 100),
                cwd,
                sessionId,
                // Without a session the block is unattributable, so it is not
                // remembered and the retry will be sandboxed again.
                denialRecorded: Boolean(sessionId),
              }),
            );
            return { output: `Error: ${DOCKER_HOST_CONTROL_RETRY_INSTRUCTION}`, status: 'failed' };
          }

          if (sandboxFailure?.type === 'denied_read') {
            if (!background && !transferred && postExecuteDeniedRead && typeof toolCallId !== 'string') {
              throw new HarnessInvariantError('Root shell denied-read handling requires an SDK tool call ID');
            }
            // Keyed by the command the model passed, not `optimizedCommand`: the
            // retry and both approval lookups (needsApproval here, and the
            // conversation layer, which has no cwd to re-derive the stripped form)
            // only ever see the raw string.
            if ((background || transferred) && postExecuteDeniedRead) {
              loggingService.security(
                'Sandbox denied read in background shell job; foreground retry is required',
                withExecutionCorrelation({
                  deniedPath: sandboxFailure.deniedRead.path,
                  suggestedParent: sandboxFailure.deniedRead.suggestedParent,
                  sensitive: sandboxFailure.deniedRead.sensitive,
                  confidence: sandboxFailure.confidence,
                  command: optimizedCommand.substring(0, 100),
                }),
              );
              return {
                output:
                  'Error: Sandbox blocked a read access. Background jobs cannot request permission after launch; rerun this command in the foreground to choose an allow option.',
                status: 'failed',
              };
            }
            if (postExecuteDeniedRead) {
              deniedReadByCallId.set(toolCallId as string, sandboxFailure.deniedRead);
            } else {
              nestedCompatibility?.deniedReads.record(command, sandboxFailure.deniedRead);
            }
            loggingService.security(
              'Sandbox denied read; agent retry will prompt for approval',
              withExecutionCorrelation({
                deniedPath: sandboxFailure.deniedRead.path,
                suggestedParent: sandboxFailure.deniedRead.suggestedParent,
                sensitive: sandboxFailure.deniedRead.sensitive,
                confidence: sandboxFailure.confidence,
                command: optimizedCommand.substring(0, 100),
              }),
            );
            return { output: `Error: ${DETAILED_DENIED_READ_INSTRUCTION}`, status: 'failed' };
          }

          const stderr = sandboxFailure ? `${sandboxFailure.stderr}\n\n${SANDBOX_ESCAPE_INSTRUCTION}` : annotatedStderr;
          const exitCode = result.exitCode ?? null;
          const outcome: ShellCommandResult['outcome'] = result.timedOut
            ? { type: 'timeout' }
            : { type: 'exit', exitCode };

          if (result.timedOut) {
            loggingService.warn(
              'Shell command timeout',
              withExecutionCorrelation({ command: optimizedCommand.substring(0, 100), timeout }),
            );
          } else if (exitCode === 0) {
            loggingService.debug(
              'Shell command executed successfully',
              withExecutionCorrelation({
                command: optimizedCommand.substring(0, 100),
                exitCode: 0,
                stdoutLength: stdout.length,
                stderrLength: stderr.length,
              }),
            );
          } else {
            loggingService.debug(
              'Shell command execution failed',
              withExecutionCorrelation({
                command: optimizedCommand.substring(0, 100),
                exitCode,
                stderrLength: stderr.length,
              }),
            );
          }

          loggingService.debug(
            'Shell command execution completed',
            withExecutionCorrelation({
              commandCount: 1,
              successCount: outcome.type === 'exit' && outcome.exitCode === 0 ? 1 : 0,
              failureCount: outcome.type === 'exit' && outcome.exitCode !== 0 ? 1 : 0,
              timeoutCount: outcome.type === 'timeout' ? 1 : 0,
            }),
          );

          const formattedOutput = await formatShellExecutionOutput({
            command: optimizedCommand,
            cwd,
            stdout,
            stderr,
            exitCode,
            timedOut: outcome.type === 'timeout',
            maxOutputLength: background || transferred ? backgroundMaxOutputLength : foregroundMaxOutputLength,
            durationMs: Date.now() - startedAt,
          });

          return {
            output: formattedOutput.text,
            status: result.timedOut ? 'timed_out' : exitCode === 0 ? 'completed' : 'failed',
          };
        };

        const cleanupAfterExecution = async () => {
          if (sandboxed) {
            await shellSandboxRunner.cleanupAfterCommand?.();
          }
          dockerHostControl?.cleanup();
          restoreForegroundCorrelation();
        };

        if (background) {
          try {
            const job = backgroundShellRegistry!.launch({
              command: optimizedCommand,
              run: executePreparedCommand,
              onStarted: (jobId) => {
                observedJobId = jobId;
                // Open the retained output stream (and the watch layer) for
                // this job at launch; settled in onSettled below.
                if (backgroundShellWatches) {
                  monitoredJobId = jobId;
                  backgroundShellWatches.open(jobId);
                }
              },
              onSettled: () => {
                // Flush matched-but-undelivered watch firings before the
                // registry emits background_shell_completed (it awaits this
                // callback first): no monitor firing may trail the terminal
                // notification. Then release shell resources as before.
                if (monitoredJobId) backgroundShellWatches?.settleJob(monitoredJobId);
                return cleanupAfterExecution();
              },
              resultToStatus: (result) => result.status,
            });
            backgroundCleanupDeferred = true;
            return JSON.stringify({ jobId: job.id, status: job.status });
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        if (backgroundShellRegistry && !sshService && typeof toolCallId === 'string') {
          const lease = backgroundShellRegistry.startForeground({
            callId: toolCallId,
            command: optimizedCommand,
            parentSignal: toolSignal,
            run: executePreparedCommand,
            onStarted: (jobId) => {
              observedJobId = jobId;
            },
            onSettled: cleanupAfterExecution,
            resultToStatus: (result) => result.status,
            onAdopted: () => {
              transferred = true;
              restoreForegroundCorrelation();
            },
          });
          // Cleanup is lease-owned now, whether it stays foreground or moves.
          backgroundCleanupDeferred = true;
          const result = await lease.foregroundResult;
          if ('jobId' in result) {
            // The tool call returns now, but only the parent-turn ownership is
            // released. Process cleanup remains deferred to lease settlement.
            restoreForegroundCorrelation();
            return JSON.stringify(result);
          }
          return result.output;
        }

        return (await executePreparedCommand(toolSignal)).output;
      } finally {
        if (!backgroundCleanupDeferred) {
          if (sandboxed) {
            await shellSandboxRunner.cleanupAfterCommand?.();
          }
          dockerHostControl?.cleanup();
          restoreForegroundCorrelation();
        }
      }
    },
    postExecutePause: postExecuteDeniedRead
      ? {
          describe: (params, _result, details) => {
            const callId = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
            if (typeof callId !== 'string') return null;
            const info = deniedReadByCallId.get(callId);
            if (!info) return null;
            return {
              toolName: 'shell',
              argumentsText: JSON.stringify(params),
              deniedRead: {
                deniedPath: info.path,
                suggestedParent: info.suggestedParent,
                sensitive: info.sensitive,
                command: params.command,
              },
            };
          },
          resolve: async ({ result, details, executeAgain }, decision) => {
            const callId = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
            const info = typeof callId === 'string' ? deniedReadByCallId.get(callId) : undefined;
            if (typeof callId === 'string') deniedReadByCallId.delete(callId);
            if (
              typeof callId !== 'string' ||
              !info ||
              (decision !== 'allow-once' && decision !== 'allow-remember' && decision !== 'unsandboxed-once')
            ) {
              return result;
            }
            if (decision === 'allow-remember') {
              getProjectAllowReadStore(executionContext?.getCwd() || process.cwd()).append(info.suggestedParent);
            }
            overrideByCallId.set(
              callId,
              decision === 'unsandboxed-once' ? { forceUnsandboxed: true } : { extraAllowRead: [info.suggestedParent] },
            );
            return executeAgain();
          },
        }
      : undefined,
    formatCommandMessage: formatShellCommandMessage,
  };
}
