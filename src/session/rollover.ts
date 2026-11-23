/** Model handoff intent, accepted now and consumed only after its real root physically settles. */
import { z } from 'zod';
import { modelToolJsonSchema } from '../shared/lib/model-tool-json-schema.js';
import type { TurnId } from '../engine/index.js';
import type { Tool } from '../tools/index.js';
import {
  SESSION_ROLLOVER_BRIEF_DESCRIPTION,
  SESSION_ROLLOVER_DESCRIPTION,
} from '../tools/session-rollover/session-rollover-tool.js';
import type { DirectRolloverRequest, DirectCommandRequest } from './command-types.js';
import type { Fact } from './facts.js';

const requestSchema = z
  .object({
    brief: z.string().max(8_000).describe(SESSION_ROLLOVER_BRIEF_DESCRIPTION),
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
      description: SESSION_ROLLOVER_DESCRIPTION,
      inputSchema: modelToolJsonSchema(requestSchema),
    },
    parallelSafe: false,
    // Must be the response's only call and cannot run from a script.
    standalone: true,
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
