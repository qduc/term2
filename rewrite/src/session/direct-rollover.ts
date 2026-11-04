/** Model handoff intent, accepted now and consumed only after its real root physically settles. */
import { z } from 'zod';
import type { TurnId } from '../engine/index.js';
import type { Tool } from '../tools/index.js';
import type { DirectRolloverRequest, DirectCommandRequest } from './direct-command-types.js';
import type { Fact } from './facts.js';

const requestSchema = z
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
export const directRolloverFactSchema = z
  .object({
    type: z.literal('rollover_requested'),
    turnId: z
      .string()
      .min(1)
      .transform((value) => value as TurnId),
    commandId: z.string().min(1),
    request: requestSchema,
  })
  .strict();
export type DirectRolloverFact = z.infer<typeof directRolloverFactSchema>;
export type DirectRolloverRequestOutcome =
  | { readonly ok: true; readonly status: 'rollover_requested'; readonly rolloverId: string }
  | { readonly ok: false; readonly status: 'rollover_blocked'; readonly error: string };

/** Root-only handoff tool. Acceptance is a request, never a claim that the successor already exists. */
export function createDirectRolloverTool(
  request: (input: DirectRolloverRequest) => DirectRolloverRequestOutcome,
): Tool<DirectRolloverRequest> & { readonly parallelSafe: false } {
  return {
    spec: {
      name: 'session_rollover',
      description:
        'Request a session rollover only when a system reminder prompts you to consider it or the user explicitly asks for one. Do not initiate rollover on your own. ' +
        'Before calling, save state the successor must not lose and the brief cannot hold (plans, findings, task state) to a durable artifact in the workspace, such as a plan doc, notes file, or commit, and point to it from the brief. Do not use /tmp for this; it does not survive a reboot. ' +
        'The brief is the only context the successor starts with, so write it for a capable engineer with no memory of this session:\n' +
        '- Goal and done condition, plus user constraints and preferences that still apply.\n' +
        '- Completed effects with durable pointers (paths, commits, docs), marking what is verified versus assumed.\n' +
        '- Working knowledge that is costly to rediscover: diagnosis, root causes, key files and symbols, and approaches ruled out with why.\n' +
        '- Next open step, concrete enough to act on immediately, and any unresolved decisions.\n' +
        '- Live background work: handle, status, and next action. Handles are session-owned and survive the rotation, so the successor can inspect or control them; do not wait for them merely to rotate, and save durable results when ready rather than copying transient output.\n' +
        '- If this session established a lasting user preference, accepted project decision, or reusable lesson learned, update persistent memory when appropriate; skip facts easily recovered from the repository, and do not save the handoff wholesale as memory.\n' +
        'Keep the brief well below the 8,000-character limit: point to a canonical artifact instead of copying it, and omit narrative history the successor can read from the previous session on demand.',
      inputSchema: z.toJSONSchema(requestSchema),
    },
    parallelSafe: false,
    parse: (raw) => requestSchema.parse(raw),
    approval: () => ({ kind: 'none' }),
    async execute(input) {
      const outcome = request(input);
      return {
        output: JSON.stringify(outcome),
        isError: !outcome.ok,
        ...(outcome.ok ? { stopAfterExecution: true as const } : {}),
      };
    },
  };
}

/** The accepted request of this completed root, whether or not its command was reserved yet. */
export function directAcceptedRolloverAt(
  facts: readonly Fact[],
  turnId: TurnId,
): Extract<Fact, { type: 'rollover_requested' }> | undefined {
  const terminal = facts.find((fact) => fact.type === 'turn_ended' && fact.turnId === turnId);
  if (terminal?.type !== 'turn_ended' || terminal.outcome !== 'completed') return undefined;
  const request = facts.find((fact) => fact.type === 'rollover_requested' && fact.turnId === turnId);
  return request?.type === 'rollover_requested' ? request : undefined;
}

/** Select only this process's completed root boundary; never replay an external rollover on reopen. */
export function directRolloverAtBoundary(facts: readonly Fact[], turnId: TurnId): DirectCommandRequest | undefined {
  const request = directAcceptedRolloverAt(facts, turnId);
  if (!request || facts.some((fact) => fact.type === 'command_started' && fact.commandId === request.commandId))
    return undefined;
  return { commandId: request.commandId, operation: { kind: 'rollover', request: structuredClone(request.request) } };
}
