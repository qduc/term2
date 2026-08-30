import { z } from 'zod';
import type { SessionRolloverRequest } from '../../contracts/session-rollover.js';
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
    brief: z.string().max(8_000),
    reason: z.enum(['context_pressure', 'task_boundary']).optional(),
  })
  .strict();

export function createSessionRolloverToolDefinition(
  requestRollover: (request: SessionRolloverRequest) => void,
): ToolDefinition<typeof sessionRolloverParameters> {
  return {
    name: 'session_rollover',
    description:
      'Request an idle-boundary rotation into a fresh session. Include a concise handoff brief with completed work, open work, and durable-state pointers.',
    parameters: sessionRolloverParameters,
    needsApproval: () => false,
    execute: (params) => {
      requestRollover(params);
      return JSON.stringify({ ok: true, status: 'rollover_requested' });
    },
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
