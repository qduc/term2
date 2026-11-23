import { z } from 'zod';
import type { FormatCommandMessage, ScriptedToolDefinition } from '../types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from '../format-helpers.js';

const ASK_ORCHESTRATOR_DESCRIPTION =
  'Ask the orchestrator (not the user) for a decision that blocks you; only this call waits. State exactly what you need.';

const askOrchestratorSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(1_200)
    .describe('The bounded blocker or decision needed from the orchestrator.'),
});

export type AskOrchestratorParams = z.infer<typeof askOrchestratorSchema>;

const formatAskOrchestratorCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  return [
    createBaseMessage(item, index, 0, false, {
      command: `ask_orchestrator: ${args.question ?? 'Unknown question'}`,
      output: getOutputText(item) || 'No answer from orchestrator',
      success: true,
      toolName: 'ask_orchestrator',
      toolArgs: args,
    }),
  ];
};

/** A subagent-only bridge to its owning async orchestrator. */
export function createAskOrchestratorToolDefinition(
  askOrchestrator: (question: string) => Promise<string>,
): ScriptedToolDefinition<typeof askOrchestratorSchema> {
  return {
    name: 'ask_orchestrator',
    description: ASK_ORCHESTRATOR_DESCRIPTION,
    scriptedReturnSchema: z.string(),
    parameters: askOrchestratorSchema,
    needsApproval: () => false,
    execute: ({ question }) => askOrchestrator(question),
    formatCommandMessage: formatAskOrchestratorCommandMessage,
  };
}
