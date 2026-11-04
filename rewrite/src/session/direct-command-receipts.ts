/** Pure command receipt decoding/projection. No writer, async lock, dispatch or replay execution. */
import { z } from 'zod';
import { directContentSchema } from './direct-queue-decode.js';
import type {
  DirectCommandFact,
  DirectCommandOutcome,
  DirectCommandReceipt,
  DirectCommandReceipts,
  DirectCommandRequest,
} from './direct-command-types.js';

const id = z.string().min(1);
const model = z.object({ provider: id, model: id }).strict();
const reasoning = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const acceptedConfiguration = z
  .object({
    model,
    reasoning: reasoning.optional(),
    temperature: z.number().finite().optional(),
  })
  .strict();
// Only request intent admits default/profile selection. Outcomes retain real
// effective values; accepted profile metadata lives in configuration_changed.
const configuration = acceptedConfiguration.partial().extend({
  reasoning: z.union([z.literal('default'), reasoning]).optional(),
  profileId: id.optional(),
});
const request = z
  .object({
    commandId: id,
    admission: z.literal('idle').optional(),
    expectedRevision: id.optional(),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('retry'), target: z.enum(['turn', 'tool']), executionId: id.optional() }).strict(),
      z.object({ kind: z.literal('compact') }).strict(),
      z.object({ kind: z.literal('rewind'), targetId: id }).strict(),
      z.object({ kind: z.literal('configure'), configuration }).strict(),
      z
        .object({
          kind: z.literal('rollover'),
          request: z
            .object({
              brief: z.string().min(1),
              reason: z.enum(['context_pressure', 'task_boundary']).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation.kind === 'retry' &&
      value.operation.target === 'turn' &&
      value.operation.executionId !== undefined
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Turn retry cannot target a tool execution' });
    if (
      value.operation.kind === 'configure' &&
      !Object.values(value.operation.configuration).some((field) => field !== undefined)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Empty configuration patch' });
  });
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retried'), turnId: id }).strict(),
  z.object({ kind: z.literal('rewound'), draft: z.object({ content: directContentSchema }).strict() }).strict(),
  z
    .object({
      kind: z.literal('compacted'),
      tokensBefore: z.number().int().nonnegative().optional(),
      tokensAfter: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('configured'), configuration: acceptedConfiguration }).strict(),
  z.object({ kind: z.literal('rolled_over'), sessionId: id }).strict(),
  z
    .object({
      kind: z.literal('rejected'),
      code: z.enum(['ineligible', 'stale', 'busy', 'unavailable', 'cancelled', 'failed']),
      message: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('interrupted'), reason: z.literal('outcome_unobserved') }).strict(),
]);
const facts = {
  command_started: z.object({ type: z.literal('command_started'), commandId: id, request, revision: id }).strict(),
  command_finished: z.object({ type: z.literal('command_finished'), commandId: id, outcome }).strict(),
};

export type DirectCommandInspection =
  | { readonly kind: 'new' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'pending' | 'finished'; readonly receipt: DirectCommandReceipt };

/** Decode only the native leaf vocabulary. Unknown types or malformed authority fields fail closed. */
export function isDirectCommandFactType(type: string): type is DirectCommandFact['type'] {
  return Object.hasOwn(facts, type);
}
/** Validate persisted bytes without stripping their original receipt/outcome payload. */
export function parseDirectCommandFact(raw: unknown): DirectCommandFact {
  const value = z.object({ type: z.string() }).parse(raw);
  if (!isDirectCommandFactType(value.type)) throw new Error(`Unknown native command fact ${value.type}`);
  facts[value.type].parse(raw);
  const fact = raw as DirectCommandFact;
  if (fact.type === 'command_started' && fact.commandId !== fact.request.commandId)
    throw new Error('Native command receipt/request identity mismatch');
  return fact;
}

/** Repeated IDs refer to exactly one original request, even after a durable rejection/interruption. */
export function inspectDirectCommand(
  state: DirectCommandReceipts,
  input: DirectCommandRequest,
): DirectCommandInspection {
  request.parse(input);
  const previous = state.find((receipt) => receipt.request.commandId === input.commandId);
  if (!previous) return { kind: 'new' };
  if (requestKey(previous.request) !== requestKey(input)) return { kind: 'conflict' };
  return { kind: previous.outcome === undefined ? 'pending' : 'finished', receipt: previous };
}

/** Plan one start receipt; Session must commit it before cancellation, model work or successor writes. */
export function planDirectCommandStart(
  state: DirectCommandReceipts,
  input: DirectCommandRequest,
  revision: string,
):
  | Exclude<DirectCommandInspection, { readonly kind: 'new' }>
  | { readonly kind: 'start'; readonly fact: Extract<DirectCommandFact, { type: 'command_started' }> } {
  id.parse(revision);
  const inspected = inspectDirectCommand(state, input);
  if (inspected.kind !== 'new') return inspected;
  return {
    kind: 'start',
    fact: { type: 'command_started', commandId: input.commandId, request: structuredClone(input), revision },
  };
}

/** Pure acceptance projection; caller installs only after the sole Session writer succeeds. */
export function reduceDirectCommandReceipts(
  state: DirectCommandReceipts,
  raw: DirectCommandFact,
): DirectCommandReceipts {
  const fact = parseDirectCommandFact(raw);
  if (fact.type === 'command_started') {
    if (inspectDirectCommand(state, fact.request).kind !== 'new')
      throw new Error('Duplicate or conflicting native command start');
    return [...state, { request: structuredClone(fact.request), revision: fact.revision }];
  }
  const index = state.findIndex((receipt) => receipt.request.commandId === fact.commandId);
  const previous = state[index];
  if (!previous || previous.outcome !== undefined) throw new Error('Native command finish has no pending owner');
  assertOutcome(previous.request, fact.outcome);
  return state.map((receipt, position) =>
    position === index ? { ...receipt, outcome: structuredClone(fact.outcome) } : receipt,
  );
}

/** Validate a truthful outcome proposal; this does not commit effects or make a capability available. */
export function planDirectCommandFinish(
  state: DirectCommandReceipts,
  commandId: string,
  result: DirectCommandOutcome,
): Extract<DirectCommandFact, { type: 'command_finished' }> {
  const fact = { type: 'command_finished', commandId, outcome: structuredClone(result) } as const;
  reduceDirectCommandReceipts(state, fact);
  return fact;
}

/** A lost receipt is unknown, not permission to run the model/tool/successor writer again. */
export function recoverDirectCommands(state: DirectCommandReceipts): readonly DirectCommandFact[] {
  return state
    .filter((receipt) => receipt.outcome === undefined)
    .map((receipt) => ({
      type: 'command_finished',
      commandId: receipt.request.commandId,
      outcome: { kind: 'interrupted', reason: 'outcome_unobserved' },
    }));
}

function requestKey(input: DirectCommandRequest): string {
  return JSON.stringify([input.admission ?? null, input.expectedRevision ?? null, operationKey(input.operation)]);
}
function operationKey(operation: DirectCommandRequest['operation']): string {
  switch (operation.kind) {
    case 'retry':
      return JSON.stringify([operation.kind, operation.target, operation.executionId ?? null]);
    case 'rewind':
      return JSON.stringify([operation.kind, operation.targetId]);
    case 'rollover':
      return JSON.stringify([operation.kind, operation.request?.brief ?? null, operation.request?.reason ?? null]);
    case 'configure':
      return JSON.stringify([
        operation.kind,
        operation.configuration.model?.provider ?? null,
        operation.configuration.model?.model ?? null,
        operation.configuration.reasoning ?? null,
        operation.configuration.temperature ?? null,
        operation.configuration.profileId ?? null,
      ]);
    default:
      return operation.kind;
  }
}
function assertOutcome(input: DirectCommandRequest, result: DirectCommandOutcome): void {
  if (result.kind === 'rejected' || result.kind === 'interrupted') return;
  const expected = {
    retry: 'retried',
    compact: 'compacted',
    rewind: 'rewound',
    configure: 'configured',
    rollover: 'rolled_over',
  } as const;
  if (result.kind !== expected[input.operation.kind])
    throw new Error('Native command outcome has wrong operation owner');
}
