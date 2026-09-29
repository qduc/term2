import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { TOOL_NAME_PROPOSE_GOAL } from '../tool-names.js';
import { createDurableGoal } from '../../services/conversation/durable-goal.js';
import type { DurableGoal } from '../../services/logging/conversation-log-events.js';
import {
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
} from '../format-helpers.js';

const PROPOSE_GOAL_DESCRIPTION =
  'Propose a durable session goal for the user to approve. Propose ONLY when the session has no durable goal yet ' +
  'and the user transitions from discussing or designing to actually implementing work — not during early ' +
  'discussion. At most once per session: if the user rejected an earlier proposal or one was already made, do not ' +
  'propose again. The user must explicitly approve; approval persists the goal, rejection changes nothing. ' +
  'The outcome must state what must become true, not a plan or step list.';

export interface ProposeGoalDeps {
  getGoal: () => DurableGoal | undefined;
  hasPriorProposal: () => boolean;
  appendGoal: (goal: DurableGoal) => void;
}

const proposeGoalSchema = z.object({
  outcome: z.string().trim().min(1).max(2000).describe('The outcome that must become true, in one or two sentences.'),
  successCriteria: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe('A short, observable condition that shows the outcome holds.'),
});

export type ProposeGoalParams = z.infer<typeof proposeGoalSchema>;

export const formatProposeGoalCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const outcome = args?.outcome ?? 'Unknown outcome';
  const command = `propose_goal: ${outcome}`;
  const output = getOutputText(item) || 'No response';
  const success = isSuccessOutput(output);

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: TOOL_NAME_PROPOSE_GOAL,
      toolArgs: args,
    }),
  ];
};

export function createProposeGoalToolDefinition(deps: ProposeGoalDeps): ToolDefinition<typeof proposeGoalSchema> {
  const isEligible = () => deps.getGoal() === undefined && !deps.hasPriorProposal();
  return {
    name: TOOL_NAME_PROPOSE_GOAL,
    description: PROPOSE_GOAL_DESCRIPTION,
    parameters: proposeGoalSchema,
    // Eligibility is checked before prompting: an ineligible proposal must not
    // reach the user's approval surface at all.
    needsApproval: () => isEligible(),
    execute: async (params) => {
      if (!isEligible()) {
        const reason =
          deps.getGoal() !== undefined ? 'a durable goal is already set' : 'a proposal was already made this session';
        return `Error: propose_goal refused because ${reason}. Use /goal set to replace an existing goal.`;
      }
      try {
        const goal = createDurableGoal(params.outcome, params.successCriteria);
        deps.appendGoal(goal);
        return `Goal proposed and persisted with the user's approval: ${goal.outcome}`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    formatCommandMessage: formatProposeGoalCommandMessage,
  };
}
