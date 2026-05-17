import { z } from 'zod';
import type { ToolDefinition, CommandMessage } from './types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from './format-helpers.js';
import type { SubagentResult } from '../services/subagents/types.js';

const runSubagentSchema = z.object({
  role: z.string().describe('The subagent role to use: "explorer", "worker", "researcher", or "mentor".'),
  task: z
    .string()
    .describe(
      'The full task description. Include all relevant context, constraints, and the expected output format. ' +
        'The subagent has no access to your conversation history or reasoning.',
    ),
  writeBoundary: z
    .array(z.string())
    .optional()
    .describe(
      'For worker role: restrict writes to these relative paths within the workspace. ' +
        'Defaults to the workspace root when omitted.',
    ),
});

export type RunSubagentParams = z.infer<typeof runSubagentSchema>;

export const formatRunSubagentCommandMessage = (
  item: any,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const role = args?.role ?? 'subagent';
  const rawOutput = getOutputText(item);
  const parsed = safeJsonParse(rawOutput) as SubagentResult | null;

  let command = `run_subagent [${role}]`;
  let output = rawOutput || 'No response';
  let success = true;

  if (parsed) {
    success = parsed.status === 'completed';
    const toolsSummary =
      parsed.toolsUsed?.length > 0
        ? `Tools: ${parsed.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`
        : '';
    const filesSummary = parsed.filesChanged?.length > 0 ? `Files changed: ${parsed.filesChanged.join(', ')}` : '';

    const parts = [parsed.finalText || parsed.error || 'No output'];
    if (toolsSummary) parts.push(toolsSummary);
    if (filesSummary) parts.push(filesSummary);
    output = parts.filter(Boolean).join('\n');

    if (parsed.error) {
      command = `run_subagent [${role}] — failed`;
    }
  }

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'run_subagent',
      toolArgs: args,
    }),
  ];
};

export const createRunSubagentToolDefinition = (
  runSubagent: (params: RunSubagentParams) => Promise<SubagentResult>,
): ToolDefinition<RunSubagentParams> => ({
  name: 'run_subagent',
  description:
    'Delegate a bounded task to a specialized subagent. The subagent runs synchronously and returns a structured result.\n\n' +
    '## Roles\n' +
    '- `explorer`: read-only workspace access. Use for locating files and answering codebase questions.\n' +
    '- `researcher`: web search + read-only workspace. Use for looking up external docs or current information.\n' +
    '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' +
    '- `worker`: read + write access. Use for implementing bounded file changes.\n\n' +
    '## Task Requirements\n' +
    'The task must be fully self-contained. Include all context, constraints, and the expected output format. ' +
    'The subagent has no access to your conversation history or reasoning.\n\n' +
    '## Write Boundary (worker only)\n' +
    'Use `writeBoundary` to restrict which paths the worker may modify. Omit to allow writes anywhere in the workspace.',
  parameters: runSubagentSchema,
  needsApproval: () => false,
  execute: async (params) => {
    try {
      const result = await runSubagent(params);
      return JSON.stringify(result);
    } catch (error: any) {
      const errorResult: SubagentResult = {
        agentId: 'error',
        role: params.role,
        status: 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message || String(error),
      };
      return JSON.stringify(errorResult);
    }
  },
  formatCommandMessage: formatRunSubagentCommandMessage,
});
