/** Pure direct-log projection: no writes, dispatch, provider calls or restored authority. */
import type { Item, ItemId } from '../model/index.js';
import type { ExecutionId, TurnId } from '../engine/index.js';
import type { ToolResult } from '../tools/index.js';
import type { ReplayedConversation } from './direct-types.js';
import type { Fact, TurnOutcomeName } from './facts.js';

export type { ReplayedConversation } from './direct-types.js';

// Kept local to the direct path: importing the old ledger would load the legacy runtime.
const OUTCOME_UNOBSERVED =
  "Outcome unobserved: the session restarted before this operation's result was recorded. " +
  'Its effect may or may not have occurred. Verify the current state before any retry, and ' +
  'do not re-run non-idempotent operations blindly.';

type Call = Extract<Item, { type: 'tool_call' }>;
type Start = Extract<Fact, { type: 'tool_started' }>;
type Slot = { item: Item | null };
type Partial = { readonly slot: Slot; readonly deltas: string[]; readonly id: ItemId };
type Occurrence = {
  readonly call: Call;
  /** Legacy calls use their position, never a provider ID or argument hash, as identity. */
  readonly key: string;
  executionId?: ExecutionId;
  settled: boolean;
};
type Execution = { start?: Start; result?: ToolResult; occurrence?: Occurrence };
type ActiveTurn = {
  readonly turnId: TurnId;
  readonly partials: Map<number | undefined, Partial>;
  readonly calls: Occurrence[];
  readonly executions: Map<ExecutionId, Execution>;
  readonly interactions: Map<string, Extract<Fact, { type: 'interaction_opened' }>>;
  readonly closedInteractions: Set<string>;
};

/**
 * Retains native items in order, with unsuperseded text at its model-step position.
 * Incomplete root occurrences get exactly one known or outcome-unobserved result;
 * nested starts/finishes remain audit only. Recovery facts are returned, not written:
 * Session must append them before the next turn's start, in the supplied order.
 */
export function replay(facts: readonly Fact[]): ReplayedConversation {
  const slots: Slot[] = [];
  const recoveryFacts: Fact[] = [];
  let active: ActiveTurn | null = null;
  let turns = 0;
  let lastOutcome: TurnOutcomeName | null = null;

  const requireActive = (turnId: TurnId, type: string): ActiveTurn => {
    if (active === null) throw new Error(`replay: ${type} for turn ${turnId} without an open turn`);
    if (active.turnId !== turnId) {
      throw new Error(`replay: ${type} for turn ${turnId} while turn ${active.turnId} is open`);
    }
    return active;
  };

  const appendItem = (turn: ActiveTurn, fact: Extract<Fact, { type: 'item' }>): void => {
    const { item, executionId } = fact;
    if (item.type === 'assistant_message') {
      // A complete item supersedes only its own step's pending text, not an earlier response.
      const partial = turn.partials.get(fact.modelStep);
      if (partial) partial.slot.item = null;
      turn.partials.delete(fact.modelStep);
    }
    if (item.type === 'tool_call') recordCall(turn, item, executionId);
    else if (item.type === 'tool_result') recordResult(turn, item, executionId);
    else if (executionId !== undefined) {
      throw new Error(`replay: executionId on non-tool item ${item.id}`);
    }
    slots.push({ item });
  };

  const finishText = (turn: ActiveTurn): void => {
    for (const partial of turn.partials.values()) {
      partial.slot.item = {
        type: 'assistant_message',
        id: partial.id,
        content: [{ type: 'text', text: partial.deltas.join('') }],
      };
    }
  };

  for (const fact of facts) {
    switch (fact.type) {
      case 'session_started':
        break;
      case 'turn_started': {
        if (active !== null) {
          throw new Error(`replay: turn ${fact.turnId} started while turn ${active.turnId} has no turn_ended`);
        }
        turns += 1;
        lastOutcome = null;
        for (const item of fact.input) slots.push({ item });
        active = {
          turnId: fact.turnId,
          partials: new Map(),
          calls: [],
          executions: new Map(),
          interactions: new Map(),
          closedInteractions: new Set(),
        };
        break;
      }
      case 'text_delta': {
        const turn = requireActive(fact.turnId, fact.type);
        if (fact.delta.length === 0) break;
        let partial = turn.partials.get(fact.modelStep);
        if (!partial) {
          // Preserve M1's ID for untagged partial text.
          const step = fact.modelStep === undefined ? '' : `-model-${fact.modelStep}`;
          partial = { slot: { item: null }, deltas: [], id: `${turn.turnId}${step}-partial` as ItemId };
          turn.partials.set(fact.modelStep, partial);
          slots.push(partial.slot);
        }
        partial.deltas.push(fact.delta);
        break;
      }
      case 'item':
        appendItem(requireActive(fact.turnId, fact.type), fact);
        break;
      case 'tool_started':
        recordStart(requireActive(fact.turnId, fact.type), fact);
        break;
      case 'tool_finished': {
        const turn = requireActive(fact.turnId, fact.type);
        const execution = turn.executions.get(fact.executionId);
        if (!execution?.start) throw new Error(`replay: finish without start for ${fact.executionId}`);
        if (execution.result) throw new Error(`replay: duplicate finish for ${fact.executionId}`);
        execution.result = fact.result;
        break;
      }
      case 'interaction_opened': {
        const turn = requireActive(fact.turnId, fact.type);
        const { request } = fact;
        if (request.turnId !== turn.turnId) throw new Error(`replay: interaction ${request.requestId} has wrong turn`);
        if (turn.interactions.has(request.requestId) || turn.closedInteractions.has(request.requestId)) {
          throw new Error(`replay: duplicate interaction ${request.requestId}`);
        }
        turn.interactions.set(request.requestId, fact);
        break;
      }
      case 'interaction_closed': {
        const turn = requireActive(fact.turnId, fact.type);
        if (!turn.interactions.delete(fact.requestId)) {
          throw new Error(`replay: closure without open interaction ${fact.requestId}`);
        }
        turn.closedInteractions.add(fact.requestId);
        break;
      }
      case 'usage':
        requireActive(fact.turnId, fact.type);
        break;
      case 'turn_ended': {
        const turn = requireActive(fact.turnId, fact.type);
        // Repairs belong before the terminal, never appended behind a closed turn.
        if (hasUnsettledRoots(turn) || turn.interactions.size !== 0) {
          throw new Error(`replay: turn ${turn.turnId} ended with unsettled calls or interactions`);
        }
        finishText(turn);
        active = null;
        lastOutcome = fact.outcome;
        break;
      }
      default: {
        const type: unknown = (fact as { type?: unknown }).type;
        throw new Error(`replay: unknown fact type ${JSON.stringify(String(type))}`);
      }
    }
  }

  if (active !== null) {
    finishText(active);
    const repairs = recoverRoots(active);
    for (const fact of repairs) {
      recoveryFacts.push(fact);
      if (fact.type === 'item') slots.push({ item: fact.item });
    }
    for (const { request } of active.interactions.values()) {
      recoveryFacts.push({
        type: 'interaction_closed',
        turnId: active.turnId,
        requestId: request.requestId,
        resolution: { kind: 'interrupted' },
      });
    }
    recoveryFacts.push({ type: 'turn_ended', turnId: active.turnId, outcome: 'interrupted' });
  }

  return {
    status: active !== null || lastOutcome === 'interrupted' ? 'interrupted' : 'idle',
    history: slots.flatMap(({ item }) => (item === null ? [] : [item])),
    nextTurn: turns + 1,
    recoveryFacts,
  };
}

function recordCall(turn: ActiveTurn, call: Call, executionId?: ExecutionId): void {
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
  turn: ActiveTurn,
  result: Extract<Item, { type: 'tool_result' }>,
  executionId?: ExecutionId,
): void {
  const occurrence =
    executionId === undefined
      ? turn.calls.find((call) => !call.settled && call.call.callId === result.callId)
      : turn.executions.get(executionId)?.occurrence;
  if (!occurrence || occurrence.settled || occurrence.call.callId !== result.callId) {
    throw new Error(`replay: unmatched or duplicate result for ${executionId ?? result.callId}`);
  }
  occurrence.settled = true;
}

function validateRootCall(start: Start, call: Call): void {
  if (start.parentExecutionId !== undefined) {
    throw new Error(`replay: nested execution ${start.executionId} cannot be a provider root call`);
  }
  if (start.callId !== call.callId || start.toolName !== call.toolName) {
    throw new Error(`replay: start/call mismatch for ${start.executionId}`);
  }
}

function recordStart(turn: ActiveTurn, start: Start): void {
  const execution = turn.executions.get(start.executionId) ?? {};
  if (execution.start) throw new Error(`replay: duplicate start for ${start.executionId}`);
  if (start.parentExecutionId !== undefined) {
    if (!turn.executions.get(start.parentExecutionId)?.start) {
      throw new Error(`replay: missing parent start for ${start.executionId}`);
    }
    if (execution.occurrence) validateRootCall(start, execution.occurrence.call);
  } else {
    // Untagged v1 items pair FIFO by call ID; repeated IDs remain distinct occurrences.
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

function hasUnsettledRoots(turn: ActiveTurn): boolean {
  return (
    turn.calls.some((call) => !call.settled) ||
    [...turn.executions.values()].some(
      (execution) => execution.start && execution.start.parentExecutionId === undefined && !execution.occurrence,
    )
  );
}

/** Missing physical terminals are never invented; nested audit remains outcome-unknown. */
function recoverRoots(turn: ActiveTurn): Fact[] {
  const facts: Fact[] = [];
  // A root start contains enough evidence to restore its call if publication was interrupted.
  // Child starts deliberately do not: they must never become extra provider calls.
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
    recordCall(turn, call, executionId);
    facts.push({ type: 'item', turnId: turn.turnId, executionId, item: call });
  }
  for (const occurrence of turn.calls) {
    if (occurrence.settled) continue;
    const { executionId, call } = occurrence;
    const known = executionId === undefined ? undefined : turn.executions.get(executionId)?.result;
    const item: Item = {
      type: 'tool_result',
      id: `${executionId ?? occurrence.key}:result` as ItemId,
      callId: call.callId,
      output: known?.output ?? OUTCOME_UNOBSERVED,
      isError: known?.isError ?? true,
      ...(known?.providerOutput === undefined ? {} : { providerOutput: known.providerOutput }),
      ...(call.toolType === undefined ? {} : { toolType: call.toolType }),
    };
    facts.push({ type: 'item', turnId: turn.turnId, item, ...(executionId === undefined ? {} : { executionId }) });
  }
  return facts;
}
