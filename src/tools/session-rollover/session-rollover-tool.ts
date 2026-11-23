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
export const SESSION_ROLLOVER_BRIEF_DESCRIPTION =
  'The handoff brief the successor starts from; under 8,000 characters.';

export const SESSION_ROLLOVER_DESCRIPTION =
  'Request a session rollover only when a system reminder prompts you to or the user explicitly asks; never on your own initiative. ' +
  'First save state the successor must not lose and the brief cannot hold (plans, findings, task state) to a durable workspace artifact (plan doc, notes file, or commit; not /tmp, which does not survive a reboot) and point to it from the brief. ' +
  "The brief is the successor's only context; write it for a capable engineer with no memory of this session:\n" +
  '- Goal, done condition, and user constraints or preferences that still apply.\n' +
  '- Completed effects with durable pointers (paths, commits, docs), marked verified or assumed.\n' +
  '- Knowledge costly to rediscover: diagnosis, root causes, key files and symbols, approaches ruled out and why.\n' +
  '- The next open step, concrete enough to act on immediately, and unresolved decisions.\n' +
  '- Live background work: handle, status, next action. Handles survive rollover and the successor can control them, so do not wait for them just to rotate; save their durable results rather than copying transient output.\n' +
  '- If this session established a lasting user preference, project decision, or reusable lesson, update persistent memory; skip facts recoverable from the repository and do not save the handoff itself as memory.\n' +
  'Keep the brief well below 8,000 characters: point to canonical artifacts instead of copying them, and omit narrative history.';

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
