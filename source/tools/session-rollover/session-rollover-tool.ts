import { z } from 'zod';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from '../../contracts/session-rollover.js';
import type { ToolDefinition } from '../types.js';
import {
  createBaseMessage,
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
} from '../format-helpers.js';

export const sessionRolloverParameters = z
  .object({
    brief: z
      .string()
      .max(8_000)
      .describe(
        'Keep well below 8,000 characters. Give the next open step, unfinished decisions, completed effects, and durable paths/commits. ' +
          'When a canonical artifact already holds the state, write a short delta and pointer instead of copying it.',
      ),
    reason: z.enum(['context_pressure', 'task_boundary']).optional(),
  })
  .strict();

export function createSessionRolloverToolDefinition(
  requestRollover: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome,
): ToolDefinition<typeof sessionRolloverParameters> {
  return {
    name: 'session_rollover',
    description:
      'Request an idle-boundary rotation into a fresh session. Live background work blocks rotation: let it settle before drafting a brief. ' +
      'Keep the brief well below the 8,000-character limit using durable-state pointers and the next open step. ' +
      'Old job and subagent handles are session-owned; save their useful results to durable artifacts rather than promising the successor can query those handles.',
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
