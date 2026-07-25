import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';
import type { SubagentResult, SubagentRunHandle } from '../../services/subagents/types.js';
import { isAbortLike } from '../../services/subagents/utils.js';

const ASYNC_ROLES = ['explorer', 'worker', 'researcher', 'mentor', 'librarian'] as const;

const runSubagentAsyncSchema = z.object({
  role: z.enum(ASYNC_ROLES).describe('The subagent role to use: explorer, worker, researcher, mentor, or librarian.'),
  task: z.string().describe('The full task description.'),
  continue_run_id: z
    .string()
    .optional()
    .describe('Continue a completed run using its runId. Required for explicit session reuse.'),
});

const getSubagentResultSchema = z.object({
  runId: z.string().describe('The runId returned by run_subagent_async.'),
});

export type RunSubagentAsyncParams = z.infer<typeof runSubagentAsyncSchema>;
export type GetSubagentResultParams = z.infer<typeof getSubagentResultSchema>;

const MAX_PREVIEW_LENGTH = 300;

function truncatePreview(text: unknown): string {
  if (typeof text !== 'string') {
    return '';
  }

  const firstParagraph =
    text
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() || '';
  if (!firstParagraph) {
    return '';
  }

  if (firstParagraph.length <= MAX_PREVIEW_LENGTH) {
    return firstParagraph;
  }

  return `${firstParagraph.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

function formatSubagentResult(result: SubagentResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
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

  const parsedOutput = safeJsonParse(rawOutput) as { runId?: string } | null;
  const runId = parsedOutput?.runId ?? rawOutput;

  if (runId && typeof runId === 'string') {
    command += ` — runId: ${runId}`;
  }

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
      'Start a subagent that runs asynchronously in the background and returns a runId immediately. ' +
      'Use this when you want to launch a subagent and continue with other work before retrieving the result. ' +
      'Fresh runs support explorer, worker, researcher, mentor, and librarian. ' +
      'Only completed non-worker runs can be continued across turns; worker continuation is blocked. ' +
      'Call get_subagent_result with the returned runId to retrieve the final SubagentResult.',
    parameters: runSubagentAsyncSchema,
    needsApproval: () => false,
    execute: async (params, context, details) => {
      try {
        const handle = await runSubagentAsync(params, context, details);
        return JSON.stringify({ runId: handle.runId, status: handle.status });
      } catch (error: any) {
        if (isAbortLike(error?.message, error)) {
          throw error;
        }
        return JSON.stringify({ runId: null, status: 'failed', error: error?.message || String(error) });
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
      'Provide the runId returned by run_subagent_async. This call blocks until the run completes.',
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
