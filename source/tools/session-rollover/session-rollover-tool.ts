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
        'Handoff for a successor with no memory of this session; keep well below 8,000 characters. ' +
          'Cover the goal, standing user constraints, verified versus assumed state, diagnosis and approaches ruled out, and the next open step. ' +
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
      'Request an idle-boundary rotation into a fresh session. The brief is the only context the successor starts with, so write it for a capable engineer with no memory of this session:\n' +
      '- Goal and done condition, plus user constraints and preferences that still apply.\n' +
      '- Completed effects with durable pointers (paths, commits, docs), marking what is verified versus assumed.\n' +
      '- Working knowledge that is costly to rediscover: diagnosis, root causes, key files and symbols, and approaches ruled out with why.\n' +
      '- Next open step, concrete enough to act on immediately, and any unresolved decisions.\n' +
      '- Live background work: handle, status, and next action. Handles are session-owned and survive the rotation, so the successor can inspect or control them; do not wait for them merely to rotate, and save durable results when ready rather than copying transient output.\n' +
      '- If this session established a lasting user preference, accepted project decision, or reusable lesson learned, update persistent memory when appropriate; skip facts easily recovered from the repository, and do not save the handoff wholesale as memory.\n' +
      'Keep the brief well below the 8,000-character limit: point to a canonical artifact instead of copying it, and omit narrative history the successor can read from the previous session on demand.',
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
