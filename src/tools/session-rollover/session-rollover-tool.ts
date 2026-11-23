import { z } from 'zod';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from '../../shared/contracts/session-rollover.js';
import type { ToolDefinition } from '../types.js';
import {
  createBaseMessage,
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
} from '../format-helpers.js';

/** Shared with the session-owned direct tool in src/session/rollover.ts. */
export const SESSION_ROLLOVER_BRIEF_DESCRIPTION = 'Under 8,000 characters.';

export const SESSION_ROLLOVER_DESCRIPTION =
  'Roll over only when a system reminder prompts it or the user asks. ' +
  'If the successor needs state the brief cannot hold, first save it to a durable workspace file or commit (not /tmp) and point to it. ' +
  "The brief is the successor's only context; write it for an engineer with no memory of this session:\n" +
  '- goal, done condition, standing user constraints\n' +
  '- completed work with pointers (paths, commits), marked verified or assumed\n' +
  '- costly knowledge: diagnosis, key files, approaches ruled out and why\n' +
  '- next concrete step and open decisions\n' +
  '- live background handles and status (they survive rollover; do not wait on them)\n' +
  'Save lasting preferences, decisions or lessons to persistent memory. Stay well under 8,000 characters: point to artifacts, skip narrative.';

const sessionRolloverParameters = z
  .object({
    brief: z.string().max(8_000).describe(SESSION_ROLLOVER_BRIEF_DESCRIPTION),
    reason: z.enum(['context_pressure', 'task_boundary']).optional(),
  })
  .strict();

export function createSessionRolloverToolDefinition(
  requestRollover: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome,
): ToolDefinition<typeof sessionRolloverParameters, 'session_rollover'> {
  return {
    name: 'session_rollover',
    description: SESSION_ROLLOVER_DESCRIPTION,
    parameters: sessionRolloverParameters,
    terminateAfterExecution: (result) =>
      typeof result === 'string' &&
      (() => {
        try {
          const parsed = JSON.parse(result) as Partial<SessionRolloverRequestOutcome>;
          return parsed.ok === true && parsed.status === 'rollover_requested';
        } catch {
          return false;
        }
      })(),
    needsApproval: () => false,
    execute: (params) => JSON.stringify(requestRollover(params)),
    formatCommandMessage: (item, index, calls) => {
      const callId = getCallIdFromItem(item);
      const args =
        normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
        (callId ? normalizeToolArguments(calls.get(callId)) : {}) ??
        {};
      const output = getOutputText(item);
      return [
        createBaseMessage(item, index, 0, false, {
          command: 'session_rollover',
          output,
          success: isSuccessOutput(output),
          toolName: 'session_rollover',
          toolArgs: args,
        }),
      ];
    },
  };
}
