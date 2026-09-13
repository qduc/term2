import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';
import type { SubagentResult } from '../../services/subagents/types.js';
import { isAbortLike, formatSubagentResult } from '../../services/subagents/utils.js';

/** Runs one fresh explorer subagent for a reviewer and returns its settled result. */
export type ExplorerRunner = (task: string, signal?: AbortSignal) => Promise<SubagentResult>;

const runExplorerSchema = z
  .object({
    task: z
      .string()
      .describe(
        'Self-contained evidence request for one bounded question: the files, symbols, or commands to inspect and the facts to report. Choose breadth or depth, never both.',
      ),
  })
  .strict();

const formatRunExplorerCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const output = getOutputText(item) || 'No response';
  const task = typeof args?.task === 'string' ? args.task.replace(/\s+/g, ' ').trim() : '';
  const preview = task.length > 120 ? `${task.slice(0, 117)}...` : task;
  return [
    createBaseMessage(item, index, 0, false, {
      command: preview ? `run_explorer ${preview}` : 'run_explorer',
      output,
      success: output.includes('Status: completed'),
      toolName: 'run_explorer',
      toolArgs: args,
    }),
  ];
};

export function createRunExplorerToolDefinition(runExplorer: ExplorerRunner): ToolDefinition {
  return {
    name: 'run_explorer',
    description:
      'Start a read-only explorer subagent to collect evidence for one bounded question. The explorer sees none of your context and returns an evidence report, not conclusions. Independent calls may run in parallel.',
    parameters: runExplorerSchema,
    parallelSafe: () => true,
    needsApproval: () => false,
    execute: async (rawParams: unknown, _context, details) => {
      const { task } = rawParams as z.infer<typeof runExplorerSchema>;
      const signal = (details as { signal?: AbortSignal } | undefined)?.signal;
      try {
        return formatSubagentResult(await runExplorer(task, signal));
      } catch (error: unknown) {
        if (isAbortLike(error instanceof Error ? error.message : undefined, error)) throw error;
        return formatSubagentResult({
          agentId: 'error',
          role: 'explorer',
          status: 'failed',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    formatCommandMessage: formatRunExplorerCommandMessage,
  };
}
