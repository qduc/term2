/**
 * engine/ — the turn loop and nothing else.
 *
 * `startTurn` (`turn.ts`) runs one turn from a `TurnSpec`: it calls the model
 * (`turn-model.ts`), dispatches the tools the model asks for (`turn-tools.ts`)
 * and emits `TurnEvent`s on a `TurnHandle`. It never writes the log. Session
 * accepts each event and only then lets the turn advance, so a crash can lose
 * at most the unaccepted tail. A few `TurnDeps` callbacks the session supplies
 * (steering, normal stop, nested runs, app-context task capabilities, and the
 * session-owned tools bound by request preparation) still write facts while the
 * engine waits on them; each is recorded with its reason in
 * scripts/rule-baseline.json and checked by scripts/check-engine-callbacks.mjs.
 * Request costs are `request_cost` events. When a tool needs approval or an answer, the
 * turn emits an interaction request and waits in memory for the session to
 * answer it; it does not call up into a UI. `startCompaction` and the
 * `recovery*` files own compaction and recovery from model failures.
 * A subagent is a nested turn run through the same loop.
 * Depends on: model, tools, config.
 * `TurnSpec.limits` bounds model requests and physical tool starts for root and
 * nested turns. Once the tool cap is reached, calls that cannot start receive
 * error results and subsequent model requests are made without tools.
 */

export type TurnId = string & { readonly __brand: 'TurnId' };

export type {
  AcceptedTurnEvent,
  ExecutionId,
  InteractionDecision,
  InteractionRequest,
  InteractionRequestId,
  ToolContextBinding,
  TurnDeps,
  TurnEvent,
  TurnCompactionEvent,
  TurnHandle,
  TurnResult,
  TurnSpec,
} from './types.js';
export { startTurn, startCompaction } from './turn.js';

export type { Tool, ToolContext, ToolRegistry } from '../tools/contracts.js';
