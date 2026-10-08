import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { TOOL_NAME_GOAL_CHECK } from '../tool-names.js';
import type { DurableGoal } from '../../services/logging/conversation-log-events.js';
import {
  GOAL_CHECK_RECORDED_PREFIX,
  goalCheckParameters,
  validateGoalCheck,
  type GoalCheckStatus,
} from '../../services/conversation/durable-goal-stop-check.js';
import {
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
} from '../format-helpers.js';

const GOAL_CHECK_DESCRIPTION =
  'Report your self-check against the active durable session goal. While the goal is active, call this by itself ' +
  'as the last tool call before ending a turn, after any work and after reading its results. Reporting achieved ' +
  'closes the goal: when the turn ends right after it, the durable goal is marked achieved. So before claiming ' +
  'achieved, verify the outcome and every success criterion against concrete evidence from this session ' +
  '(commands you ran and their results, files you read); if anything is unverified, keep working or report ' +
  'blocked instead. It grants no permission and does not override newer user instructions. Use deferred when the ' +
  'latest user message asked for something other than the goal or asked you to pause.';

const RESULT_TEXT: Record<GoalCheckStatus, string> = {
  achieved:
    `${GOAL_CHECK_RECORDED_PREFIX} achieved. The durable goal is marked achieved when you end the turn now; ` +
    'more tool work first means checking again. End the turn now with a short summary of the evidence.',
  blocked:
    `${GOAL_CHECK_RECORDED_PREFIX} blocked. Control returns to the user. End the turn now and state plainly what is ` +
    'blocking and what input or capability is needed.',
  not_achieved:
    `${GOAL_CHECK_RECORDED_PREFIX} not achieved. Continue working toward the outcome now, within the user instructions ` +
    'and approvals, and call goal_check again before ending the turn.',
  deferred:
    `${GOAL_CHECK_RECORDED_PREFIX} deferred. The durable goal stays active and unchanged. Finish the user’s latest ` +
    'request and end the turn.',
};

export const formatGoalCheckCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const status = typeof args?.status === 'string' ? args.status : 'unknown';
  const evidence = typeof args?.evidence === 'string' ? `: ${args.evidence}` : '';
  const output = getOutputText(item) || 'No response';
  return [
    createBaseMessage(item, index, 0, false, {
      command: `goal_check ${status}${evidence}`,
      output,
      success: isSuccessOutput(output),
      toolName: TOOL_NAME_GOAL_CHECK,
      toolArgs: args,
    }),
  ];
};

/**
 * The working model's stop self-check for an active durable goal.
 *
 * Execution validates and acknowledges the report; the stop decision is made
 * from the turn history by `decideGoalStop`. The tool holds no state and has no
 * write path of its own: an achieved check closes the goal only at the stop
 * seam (`createGoalStopPolicy`), once it is known to be the turn's last word.
 */
export function createGoalCheckToolDefinition(deps: {
  getGoal: () => DurableGoal | undefined;
}): ToolDefinition<typeof goalCheckParameters> {
  return {
    name: TOOL_NAME_GOAL_CHECK,
    description: GOAL_CHECK_DESCRIPTION,
    parameters: goalCheckParameters,
    needsApproval: () => false,
    execute: (params) => {
      const validation = validateGoalCheck(params, deps.getGoal());
      if (!validation.ok) return `Error: goal_check was not recorded: ${validation.problem}.`;
      return RESULT_TEXT[validation.check.status];
    },
    formatCommandMessage: formatGoalCheckCommandMessage,
  };
}
