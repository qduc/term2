/** Model handoff intent, accepted now and consumed only after its real root physically settles. */
import { z } from 'zod';
import type { TurnId } from '../engine/index.js';
import type { Tool } from '../tools/index.js';
import type { DirectRolloverRequest, DirectCommandRequest } from './direct-command-types.js';
import type { Fact } from './facts.js';

const requestSchema = z
  .object({
    brief: z.string().max(8_000),
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
): Tool<DirectRolloverRequest> {
  return {
    spec: {
      name: 'session_rollover',
      description:
        'Request a session rollover only when a system reminder prompts you to consider it or the user explicitly asks for one. Do not initiate rollover on your own. ' +
        'Before calling, save state the successor must not lose and the brief cannot hold to a durable workspace artifact (not /tmp), and point to it from the brief. ' +
        'The brief is the only context the successor starts with: include the goal and done condition, standing constraints, completed effects with durable pointers and verified versus assumed state, ' +
        'diagnosis and approaches ruled out, the next concrete step and unresolved decisions, and live background work with handles/status/next action. ' +
        'Save reusable lessons in relevant project documentation or memory when appropriate; do not save the handoff wholesale as memory. ' +
        'Keep the brief well below 8,000 characters; prefer a short delta and canonical artifact pointer over copying history. ' +
        'Call this tool alone after other tool results. A request stops this root only after its tool result is accepted; the actual rollover authority runs at the settled boundary and can still refuse.',
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

/** Select only this process's completed root boundary; never replay an external rollover on reopen. */
export function directRolloverAtBoundary(facts: readonly Fact[], turnId: TurnId): DirectCommandRequest | undefined {
  const terminal = facts.find((fact) => fact.type === 'turn_ended' && fact.turnId === turnId);
  if (terminal?.type !== 'turn_ended' || terminal.outcome !== 'completed') return undefined;
  const request = facts.find((fact) => fact.type === 'rollover_requested' && fact.turnId === turnId);
  if (
    request?.type !== 'rollover_requested' ||
    facts.some((fact) => fact.type === 'command_started' && fact.commandId === request.commandId)
  )
    return undefined;
  return { commandId: request.commandId, operation: { kind: 'rollover', request: structuredClone(request.request) } };
}
