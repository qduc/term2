/**
 * engine/ — the turn loop and nothing else.
 *
 * Takes history, tools and a model and runs one turn, emitting one event
 * stream. When a tool needs approval it suspends and returns a serializable
 * continuation instead of calling up into a UI. Owns compaction. A subagent is
 * a nested engine run whose events are wrapped in `subagent`.
 * Depends on: model, tools, config.
 */

import type { Item, ItemId, ModelError, ModelRef, ReasoningEffort, ToolCallId, Usage } from '../model/index.js';
import type { ApprovalRequirement, Tool, ToolContext, ToolResult } from '../tools/index.js';

export type TurnId = string & { readonly __brand: 'TurnId' };
export type AgentId = string & { readonly __brand: 'AgentId' };

export type TurnBudget = {
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
};

export type TurnInput = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  /** Appended to history at the start of the turn. Empty for a retry. */
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly tools: readonly Tool[];
  readonly toolContext: Omit<ToolContext, 'signal' | 'progress'>;
  readonly budget: TurnBudget;
};

/**
 * Everything needed to pick a turn back up: after an approval, or after a
 * crash at a tool-call boundary. Plain data so `session/` can persist it.
 */
export type TurnCheckpoint = {
  readonly turnId: TurnId;
  readonly input: TurnInput;
  /** Items the turn has produced so far. */
  readonly produced: readonly Item[];
  /** Tool calls the model asked for that have not produced a result yet. */
  readonly pendingCalls: readonly { readonly callId: ToolCallId; readonly toolName: string; readonly input: unknown }[];
  readonly modelCalls: number;
  readonly continuation?: unknown;
};

export type ApprovalRequest = {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly requirement: Extract<ApprovalRequirement, { kind: 'ask' }>;
  /** Set when the request comes from a nested agent. */
  readonly agentId?: AgentId;
};

export type ApprovalDecision = { readonly kind: 'approve' } | { readonly kind: 'reject'; readonly reason?: string };

export type TurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'suspended'; readonly approvals: readonly ApprovalRequest[]; readonly checkpoint: TurnCheckpoint }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'failed'; readonly error: ModelError };

export type EngineEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  /** A finished history item. The session log stores these; deltas are transient. */
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'tool_started'; readonly callId: ToolCallId; readonly toolName: string; readonly input: unknown }
  | { readonly type: 'tool_progress'; readonly callId: ToolCallId; readonly chunk: string }
  | { readonly type: 'tool_finished'; readonly callId: ToolCallId; readonly result: ToolResult }
  /** Emitted at each tool-call boundary. Persisting the latest one makes the turn resumable. */
  | { readonly type: 'checkpoint'; readonly checkpoint: TurnCheckpoint }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'retrying'; readonly attempt: number; readonly delayMs: number; readonly error: ModelError }
  | { readonly type: 'compacted'; readonly summaryId: ItemId; readonly replaced: number }
  | { readonly type: 'subagent'; readonly agentId: AgentId; readonly role: string; readonly event: EngineEvent }
  | { readonly type: 'turn_ended'; readonly outcome: TurnOutcome };

/** A running turn. Iterate `events`; the last event is always `turn_ended`. */
export interface TurnRun {
  readonly turnId: TurnId;
  readonly events: AsyncIterable<EngineEvent>;
  cancel(): void;
}

export interface Engine {
  start(input: TurnInput): TurnRun;
  /** Continue a suspended or crashed turn. Decisions are keyed by tool call. */
  resume(checkpoint: TurnCheckpoint, decisions: ReadonlyMap<ToolCallId, ApprovalDecision>): TurnRun;
}

export interface Compactor {
  /** Returns a shorter history with `summary` items standing in for older spans. */
  compact(history: readonly Item[], model: ModelRef, signal: AbortSignal): Promise<readonly Item[]>;
  shouldCompact(history: readonly Item[], model: ModelRef): boolean;
}
