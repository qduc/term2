/** Active root reconstruction, including physical tool-occurrence identity and repair. */
import type { ExecutionId, TurnId } from '../engine/index.js';
import type { Item, ItemId } from '../model/index.js';
import type { ToolResult } from '../tools/index.js';
import type { Fact } from './facts.js';

const OUTCOME_UNOBSERVED =
  "Outcome unobserved: the session restarted before this operation's result was recorded. " +
  'Its effect may or may not have occurred. Verify the current state before any retry, and ' +
  'do not re-run non-idempotent operations blindly.';

const LIVE_OUTCOME_UNOBSERVED =
  "Outcome unobserved: the turn ended before this operation's result was recorded. " +
  'Its effect may or may not have occurred. Verify the current state before any retry, and ' +
  'do not re-run non-idempotent operations blindly.';

type Call = Extract<Item, { type: 'tool_call' }>;
type Start = Extract<Fact, { type: 'tool_started' }>;
type Slot = { item: Item | null };
type Partial = { readonly slot: Slot; readonly deltas: string[]; readonly id: ItemId };
type Occurrence = { readonly call: Call; readonly key: string; executionId?: ExecutionId; settled: boolean };
type Execution = { start?: Start; result?: ToolResult; occurrence?: Occurrence };

export type ActiveReplayTurn = {
  readonly turnId: TurnId;
  readonly partials: Map<number | undefined, Partial>;
  readonly calls: Occurrence[];
  readonly executions: Map<ExecutionId, Execution>;
  readonly interactions: Map<string, Extract<Fact, { type: 'interaction_opened' }>>;
  readonly closedInteractions: Set<string>;
  readonly responses: Set<number>;
  readonly budgets: Map<string, Extract<Fact, { type: 'budget_opened' }>>;
  readonly closedBudgets: Set<string>;
};

export function createActiveReplayTurn(turnId: TurnId): ActiveReplayTurn {
  return {
    turnId,
    partials: new Map(),
    calls: [],
    executions: new Map(),
    interactions: new Map(),
    closedInteractions: new Set(),
    responses: new Set(),
    budgets: new Map(),
    closedBudgets: new Set(),
  };
}

export function appendReplayItem(turn: ActiveReplayTurn, fact: Extract<Fact, { type: 'item' }>, slots: Slot[]): void {
  const { item, executionId } = fact;
  if (item.type === 'assistant_message') {
    const partial = turn.partials.get(fact.modelStep);
    if (partial) partial.slot.item = null;
    turn.partials.delete(fact.modelStep);
  }
  if (item.type === 'tool_call') recordCall(turn, item, executionId);
  else if (item.type === 'tool_result') recordResult(turn, item, executionId);
  else if (executionId !== undefined) throw new Error(`replay: executionId on non-tool item ${item.id}`);
  slots.push({ item });
}

export function appendReplayDelta(
  turn: ActiveReplayTurn,
  fact: Extract<Fact, { type: 'text_delta' }>,
  slots: Slot[],
): void {
  if (fact.delta.length === 0) return;
  let partial = turn.partials.get(fact.modelStep);
  if (!partial) {
    const step = fact.modelStep === undefined ? '' : `-model-${fact.modelStep}`;
    partial = { slot: { item: null }, deltas: [], id: `${turn.turnId}${step}-partial` as ItemId };
    turn.partials.set(fact.modelStep, partial);
    slots.push(partial.slot);
  }
  partial.deltas.push(fact.delta);
}

export function finishReplayText(turn: ActiveReplayTurn): void {
  for (const partial of turn.partials.values())
    partial.slot.item = {
      type: 'assistant_message',
      id: partial.id,
      content: [{ type: 'text', text: partial.deltas.join('') }],
    };
}

export function recordReplayStart(turn: ActiveReplayTurn, start: Start): void {
  const execution = turn.executions.get(start.executionId) ?? {};
  if (execution.start) throw new Error(`replay: duplicate start for ${start.executionId}`);
  if (start.parentExecutionId !== undefined) {
    if (!turn.executions.get(start.parentExecutionId)?.start)
      throw new Error(`replay: missing parent start for ${start.executionId}`);
    if (execution.occurrence) validateRootCall(start, execution.occurrence.call);
  } else {
    const occurrence =
      execution.occurrence ??
      turn.calls.find(
        (call) =>
          call.executionId === undefined &&
          !call.settled &&
          call.call.callId === start.callId &&
          call.call.toolName === start.toolName,
      );
    if (occurrence) {
      validateRootCall(start, occurrence.call);
      occurrence.executionId = start.executionId;
      execution.occurrence = occurrence;
    }
  }
  execution.start = start;
  turn.executions.set(start.executionId, execution);
}

export function hasUnsettledReplayRoots(turn: ActiveReplayTurn): boolean {
  return (
    turn.calls.some((call) => !call.settled) ||
    [...turn.executions.values()].some(
      (execution) => execution.start && execution.start.parentExecutionId === undefined && !execution.occurrence,
    )
  );
}

/** Only drained live settlement can infer non-execution from an absent durable start.
 * Reopen keeps the conservative restart fallback; accepted results always win. */
export function recoverReplayRoots(turn: ActiveReplayTurn, settlement: 'restart' | 'live' = 'restart'): Fact[] {
  const facts: Fact[] = [];
  const occurrences = [...turn.calls];
  for (const [executionId, execution] of turn.executions) {
    const start = execution.start;
    if (!start || start.parentExecutionId !== undefined || execution.occurrence) continue;
    const call: Call = {
      type: 'tool_call',
      id: `${executionId}:call` as ItemId,
      callId: start.callId as Call['callId'],
      toolName: start.toolName,
      input: start.input,
    };
    occurrences.push({ call, key: `${executionId}:recovery`, executionId, settled: false });
    facts.push({ type: 'item', turnId: turn.turnId, executionId, item: call });
  }
  for (const occurrence of occurrences) {
    if (occurrence.settled) continue;
    const { executionId, call } = occurrence;
    const execution = executionId === undefined ? undefined : turn.executions.get(executionId);
    const known = execution?.result;
    const missing =
      settlement === 'restart'
        ? OUTCOME_UNOBSERVED
        : execution?.start
        ? LIVE_OUTCOME_UNOBSERVED
        : 'Tool execution was interrupted before it started.';
    const item: Item = {
      type: 'tool_result',
      id: `${executionId ?? occurrence.key}:result` as ItemId,
      callId: call.callId,
      output: known?.output ?? missing,
      isError: known?.isError ?? true,
      ...(known?.providerOutput === undefined ? {} : { providerOutput: known.providerOutput }),
      ...(call.toolType === undefined ? {} : { toolType: call.toolType }),
    };
    facts.push({ type: 'item', turnId: turn.turnId, item, ...(executionId === undefined ? {} : { executionId }) });
  }
  return facts;
}

function recordCall(turn: ActiveReplayTurn, call: Call, executionId?: ExecutionId): void {
  const occurrence: Occurrence = {
    call,
    key: `${turn.turnId}:legacy:${turn.calls.length + 1}`,
    executionId,
    settled: false,
  };
  if (executionId !== undefined) {
    const execution = turn.executions.get(executionId) ?? {};
    if (execution.occurrence) throw new Error(`replay: duplicate call for ${executionId}`);
    if (execution.start) validateRootCall(execution.start, call);
    execution.occurrence = occurrence;
    turn.executions.set(executionId, execution);
  }
  turn.calls.push(occurrence);
}

function recordResult(
  turn: ActiveReplayTurn,
  result: Extract<Item, { type: 'tool_result' }>,
  executionId?: ExecutionId,
): void {
  const occurrence =
    executionId === undefined
      ? turn.calls.find((call) => !call.settled && call.call.callId === result.callId)
      : turn.executions.get(executionId)?.occurrence;
  if (!occurrence || occurrence.settled || occurrence.call.callId !== result.callId)
    throw new Error(`replay: unmatched or duplicate result for ${executionId ?? result.callId}`);
  occurrence.settled = true;
}

function validateRootCall(start: Start, call: Call): void {
  if (start.parentExecutionId !== undefined)
    throw new Error(`replay: nested execution ${start.executionId} cannot be a provider root call`);
  if (start.callId !== call.callId || start.toolName !== call.toolName)
    throw new Error(`replay: start/call mismatch for ${start.executionId}`);
}
