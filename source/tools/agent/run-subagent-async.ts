import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';
import type { SubagentResult, SubagentRunHandle, SubagentRunStatus } from '../../services/subagents/types.js';
import { SUBAGENT_RUN_NAME_PATTERN, SubagentRegistryError } from '../../services/subagents/subagent-async-registry.js';
import { isAbortLike, truncatePreview } from '../../services/subagents/utils.js';

const ASYNC_ROLES = ['explorer', 'worker', 'researcher', 'mentor', 'librarian'] as const;

const runSubagentAsyncSchema = z.object({
  role: z.enum(ASYNC_ROLES).describe('The subagent role to use: explorer, worker, researcher, mentor, or librarian.'),
  task: z.string().describe('The full task description.'),
  name: z
    .string()
    .regex(SUBAGENT_RUN_NAME_PATTERN)
    .optional()
    .describe(
      'Optional active-run alias: lowercase letter first, then up to 31 lowercase letters, digits, underscores, or hyphens.',
    ),
  continue_run_id: z
    .string()
    .optional()
    .describe('Continue a completed run using its runId. Required for explicit session reuse.'),
});

const getSubagentResultSchema = z.object({
  runId: z.string().describe('The runId returned by run_subagent_async.'),
});

const getSubagentStatusSchema = z.object({
  runId: z.string().optional().describe('The runId to inspect. Omit to list the status of all current runs at once.'),
});

const sendMessageSchema = z.object({
  target: z.string().trim().min(1).max(128).describe('The active run name or canonical runId to steer or answer.'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe('Bounded steering guidance, or the answer to the referenced ask_orchestrator question.'),
  reply_to: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Optional ask_orchestrator messageId. When provided, message answers that exact pending question.'),
});

const cancelRunSchema = z.object({
  target: z.string().trim().min(1).max(128).describe('The active run name or canonical runId to cancel.'),
});

export type GetSubagentStatusParams = z.infer<typeof getSubagentStatusSchema>;

export type RunSubagentAsyncParams = z.infer<typeof runSubagentAsyncSchema>;
export type GetSubagentResultParams = z.infer<typeof getSubagentResultSchema>;
export type SendMessageParams = z.infer<typeof sendMessageSchema>;
export type CancelRunParams = z.infer<typeof cancelRunSchema>;

export type SendMessageAcknowledgement =
  | { ok: true; runId: string; status: 'running'; delivery: 'queued' | 'answered' }
  | { ok: false; code: string; target: string };

export type CancelRunAcknowledgement =
  | { ok: true; runId: string; status: 'cancelling' }
  | { ok: false; code: 'not_active'; target: string };

function formatSubagentResult(result: SubagentResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  // Structured validation evidence (machine-checkable, before narrative).
  if (result.validation) {
    lines.push('');
    const v = result.validation;
    lines.push(`Validation: ${v.command} → exit ${v.exitStatus}`);
    if (v.outputExcerpt) {
      const excerpt = v.outputExcerpt.length > 500 ? v.outputExcerpt.slice(-500) + '...' : v.outputExcerpt;
      lines.push(`Output excerpt: ${excerpt}`);
    }
  }

  // Structured diff stat (machine-checkable, before narrative).
  if (result.diffStat && result.diffStat.length > 0) {
    lines.push('');
    const stats = result.diffStat.map((d) => `  ${d.path} +${d.added}/-${d.deleted}`).join('\n');
    lines.push(`Diff stat:`);
    lines.push(stats);
  }

  if (result.finalText) {
    lines.push('');
    lines.push(result.finalText);
  }

  if (result.toolsUsed && result.toolsUsed.length > 0) {
    lines.push('');
    lines.push(`Tools used: ${result.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`);
  }

  if (result.filesChanged && result.filesChanged.length > 0) {
    lines.push('');
    lines.push(`Files changed: ${result.filesChanged.join(', ')}`);
  }

  return lines.join('\n') || `Status: ${result.status}`;
}

export const formatRunSubagentAsyncCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const role = args?.role ?? 'subagent';
  const rawOutput = getOutputText(item);
  const taskPreview = truncatePreview(args?.task);
  let command = taskPreview ? `run_subagent_async [${role}] ${taskPreview}` : `run_subagent_async [${role}]`;

  const parsedOutput = safeJsonParse(rawOutput) as { runId?: string; name?: string } | null;
  const runId = parsedOutput?.runId ?? rawOutput;

  if (runId && typeof runId === 'string') {
    command += ` — runId: ${runId}`;
  }
  if (parsedOutput?.name) command += ` — name: ${parsedOutput.name}`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output: rawOutput || 'No response',
      success: true,
      toolName: 'run_subagent_async',
      toolArgs: args,
    }),
  ];
};

export const formatGetSubagentResultCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const rawOutput = getOutputText(item);
  const parsed = safeJsonParse(rawOutput) as SubagentResult | null;

  const runId = args?.runId ?? 'unknown';
  let command = `get_subagent_result [${runId}]`;
  let output = rawOutput || 'No response';
  let success = true;

  if (parsed) {
    success = parsed.status === 'completed';
    command =
      parsed.status === 'cancelled'
        ? `get_subagent_result [${runId}] — cancelled`
        : parsed.status === 'failed'
        ? `get_subagent_result [${runId}] — failed`
        : `get_subagent_result [${runId}]`;

    const outputPreview = truncatePreview(parsed.finalText || parsed.error || 'No output');
    const parts = [outputPreview];
    if (parsed.toolsUsed?.length > 0) {
      parts.push(`Tools: ${parsed.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`);
    }
    if (parsed.filesChanged?.length > 0) {
      parts.push(`Files changed: ${parsed.filesChanged.join(', ')}`);
    }
    output = parts.filter(Boolean).join('\n');
  } else if (rawOutput?.includes('Status: failed')) {
    success = false;
    command = `get_subagent_result [${runId}] — failed`;
  } else if (rawOutput?.includes('Status: cancelled')) {
    success = false;
    command = `get_subagent_result [${runId}] — cancelled`;
  }

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'get_subagent_result',
      toolArgs: args,
    }),
  ];
};

export function createRunSubagentAsyncToolDefinition(
  runSubagentAsync: (
    params: RunSubagentAsyncParams,
    context?: unknown,
    details?: unknown,
  ) => Promise<SubagentRunHandle>,
): ToolDefinition<RunSubagentAsyncParams> {
  return {
    name: 'run_subagent_async',
    description:
      'Start a subagent that runs asynchronously in the background and returns a runId immediately — the call does NOT block. ' +
      'After a successful launch, do NOT immediately call get_subagent_result; that call blocks until completion and freezes you out of doing other work or receiving the next user instruction. ' +
      'Instead, end your turn and wait for the harness automatic completion notification, then collect the result with get_subagent_result from a later turn. ' +
      'A returned handle with status: "running" means the launch succeeded; do not duplicate the delegated task. ' +
      'Only call get_subagent_result inline if, after honest assessment, you truly cannot take any other useful action or reply to the user without the result at all. ' +
      'Fresh runs support explorer, worker, researcher, mentor, and librarian. ' +
      'Only completed non-worker runs can be continued across turns; worker continuation is blocked.',
    parameters: runSubagentAsyncSchema,
    needsApproval: () => false,
    execute: async (params, context, details) => {
      try {
        const handle = await runSubagentAsync(params, context, details);
        const handleOutput: Record<string, string> = { runId: handle.runId, status: handle.status };
        if (handle.name) handleOutput.name = handle.name;
        if (handle.status === 'running') {
          handleOutput.hint =
            'Background run launched — do NOT call get_subagent_result now. End your turn and wait for the completion notification, then collect the result from a later turn.';
        }
        return JSON.stringify(handleOutput);
      } catch (error: any) {
        if (isAbortLike(error?.message, error)) {
          throw error;
        }
        if (error instanceof SubagentRegistryError) {
          return JSON.stringify({ status: 'failed', error: { code: error.code, message: error.message } });
        }
        return JSON.stringify({
          status: 'failed',
          error: { code: 'execution_failed', message: error?.message || String(error) },
        });
      }
    },
    formatCommandMessage: formatRunSubagentAsyncCommandMessage,
  };
}

export function createGetSubagentResultToolDefinition(
  getSubagentResult: (params: GetSubagentResultParams, context?: unknown, details?: unknown) => Promise<SubagentResult>,
): ToolDefinition<GetSubagentResultParams> {
  return {
    name: 'get_subagent_result',
    description:
      'Retrieve the final result of an asynchronous subagent run started with run_subagent_async. ' +
      'Provide the runId returned by run_subagent_async. This call BLOCKS until the run completes. ' +
      'Do not call it immediately after launching a subagent — that defeats async and freezes you out of doing other work. ' +
      'Prefer waiting for the harness automatic completion notification and call this from a later turn; only call it inline if you genuinely cannot proceed without the result now.',
    parameters: getSubagentResultSchema,
    needsApproval: () => false,
    execute: async (params, context, details) => {
      try {
        const result = await getSubagentResult(params, context, details);
        return formatSubagentResult(result);
      } catch (error: any) {
        if (isAbortLike(error?.message, error)) {
          throw error;
        }
        if (error instanceof SubagentRegistryError) {
          return JSON.stringify({
            status: 'failed',
            error: { code: error.code, message: error.message },
            runId: params.runId,
          });
        }
        const errorResult: SubagentResult = {
          agentId: params.runId,
          role: 'unknown',
          status: 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: error?.message || String(error),
        };
        return formatSubagentResult(errorResult);
      }
    },
    formatCommandMessage: formatGetSubagentResultCommandMessage,
  };
}

function formatSubagentStatus(status: SubagentRunStatus | SubagentRunStatus[]): string {
  const formatOne = (s: SubagentRunStatus): string => {
    const parts = [
      `${s.name ? `${s.name} (${s.runId})` : s.runId} [${s.role}] ${s.status}`,
      `task: ${s.taskPreview || '(none)'}`,
      `elapsed: ${Math.round(s.elapsedMs / 1000)}s`,
    ];
    if (s.lastToolName) parts.push(`lastTool: ${s.lastToolName}`);
    const toolSummary = Object.entries(s.toolCounts)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');
    if (toolSummary) parts.push(`tools: ${toolSummary}`);
    return parts.join(' | ');
  };

  if (Array.isArray(status)) {
    if (status.length === 0) return 'No subagent runs.';
    return status.map(formatOne).join('\n');
  }
  if (status.status === 'not_found') {
    return `Run ${status.runId} was not found (evicted or never existed).`;
  }
  if (status.status === 'running' || status.status === 'waiting_for_answer' || status.status === 'cancelling') {
    return `${formatOne(
      status,
    )}\n\nThis run is still in progress. Call get_subagent_result for the full report once it completes.`;
  }
  return `${formatOne(status)}\n\nThis run has finished. Call get_subagent_result for the full report.`;
}

export const formatGetSubagentStatusCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const rawOutput = getOutputText(item);
  const runId = args?.runId ?? 'all';
  const command = rawOutput?.includes('not found')
    ? `get_subagent_status [${runId}] — not found`
    : `get_subagent_status [${runId}]`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output: rawOutput || 'No status',
      success: true,
      toolName: 'get_subagent_status',
      toolArgs: args,
    }),
  ];
};

export function createGetSubagentStatusToolDefinition(
  getSubagentStatus: (
    params: GetSubagentStatusParams,
    context?: unknown,
    details?: unknown,
  ) => SubagentRunStatus | SubagentRunStatus[],
): ToolDefinition<GetSubagentStatusParams> {
  return {
    name: 'get_subagent_status',
    description:
      'Non-blocking status of one async subagent run (runId provided) or all runs (runId omitted). ' +
      'Use this to answer a mid-run "what is it doing" question without blocking your turn. ' +
      'Returns status, elapsed, last tool, and tool counts only — never the final report or diff evidence. ' +
      'For a finished or settled run, call get_subagent_result to retrieve the full report. ' +
      'This call never blocks and never awaits a run.',
    parameters: getSubagentStatusSchema,
    needsApproval: () => false,
    execute: (params, context, details) => {
      try {
        const status = getSubagentStatus(params, context, details);
        return formatSubagentStatus(status);
      } catch (error: any) {
        return JSON.stringify({
          status: 'failed',
          error: { code: 'execution_failed', message: error?.message || String(error) },
        });
      }
    },
    formatCommandMessage: formatGetSubagentStatusCommandMessage,
  };
}

export const formatSendMessageCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const rawOutput = getOutputText(item);
  const acknowledgement = safeJsonParse(rawOutput) as SendMessageAcknowledgement | null;
  const successfulAcknowledgement = acknowledgement !== null && acknowledgement.ok;
  const failureCode = acknowledgement !== null && !acknowledgement.ok ? acknowledgement.code : undefined;
  const target = args.target ?? (successfulAcknowledgement ? acknowledgement.runId : 'unknown');
  const command = successfulAcknowledgement
    ? `send_message [${target}] — ${acknowledgement.delivery}`
    : `send_message [${target}] — ${failureCode ?? 'failed'}`;
  const output = successfulAcknowledgement
    ? `Message ${acknowledgement.delivery} for ${acknowledgement.runId}; run remains ${acknowledgement.status}.`
    : `Message was not delivered: ${failureCode ?? rawOutput ?? 'unknown error'}.`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success: successfulAcknowledgement,
      toolName: 'send_message',
      toolArgs: args,
    }),
  ];
};

export const formatCancelRunCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const rawOutput = getOutputText(item);
  const acknowledgement = safeJsonParse(rawOutput) as CancelRunAcknowledgement | null;
  const successfulAcknowledgement = acknowledgement !== null && acknowledgement.ok;
  const failureCode = acknowledgement !== null && !acknowledgement.ok ? acknowledgement.code : undefined;
  const target = args.target ?? (successfulAcknowledgement ? acknowledgement.runId : 'unknown');
  const command = successfulAcknowledgement
    ? `cancel_run [${target}] — cancelling`
    : `cancel_run [${target}] — ${failureCode ?? 'failed'}`;
  const output = successfulAcknowledgement
    ? `Cancellation requested for ${acknowledgement.runId}; awaiting normal completion.`
    : `Run is not active: ${target}.`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success: successfulAcknowledgement,
      toolName: 'cancel_run',
      toolArgs: args,
    }),
  ];
};

/** Parent-only, non-blocking control channel for an active async execution run. */
export function createSendMessageToolDefinition(
  sendMessage: (params: SendMessageParams) => SendMessageAcknowledgement,
): ToolDefinition<SendMessageParams> {
  return {
    name: 'send_message',
    description:
      'Queue non-blocking steering for an active async execution run addressed by its active name or canonical runId; this does NOT wait for a result. ' +
      'Steering is delivered by safely ending the current model stream (never an active tool) and starting a bounded fresh session turn; it is not live SDK input injection. ' +
      'A logical run permits at most three steering continuation segments. Do not immediately call get_subagent_result after this acknowledgement; wait for normal completion notification. ' +
      'To answer a waiting ask_orchestrator question, provide its messageId as reply_to; the message then answers that exact question and its tool call continues. ' +
      'The mentor role does not support steering. Use cancel_run to stop a run instead of sending a correction that must not continue.',
    parameters: sendMessageSchema,
    needsApproval: () => false,
    execute: (params) => JSON.stringify(sendMessage(params)),
    formatCommandMessage: formatSendMessageCommandMessage,
  };
}

/** Parent-only, non-blocking request for two-phase async run cancellation. */
export function createCancelRunToolDefinition(
  cancelRun: (params: CancelRunParams) => CancelRunAcknowledgement,
): ToolDefinition<CancelRunParams> {
  return {
    name: 'cancel_run',
    description:
      'Request non-blocking two-phase cancellation of an active async run by active name or canonical runId. This does NOT wait for the result. ' +
      'It returns cancelling immediately; the runner later settles through the normal completion path with truthful partial work, tool, diff, and validation evidence. ' +
      'Do not immediately call get_subagent_result after this acknowledgement; wait for normal completion notification. ' +
      'Use send_message to steer productive execution; use cancel_run when the run should stop.',
    parameters: cancelRunSchema,
    needsApproval: () => false,
    execute: (params) => JSON.stringify(cancelRun(params)),
    formatCommandMessage: formatCancelRunCommandMessage,
  };
}
