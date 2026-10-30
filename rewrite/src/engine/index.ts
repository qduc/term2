/**
 * engine/ — the turn loop and nothing else.
 *
 * Takes history, tools and a model and runs one turn, emitting one event
 * stream. When a tool needs approval it suspends and returns a serializable
 * continuation instead of calling up into a UI. Owns compaction. A subagent is
 * a nested engine run whose events are wrapped in `subagent`.
 * Depends on: model, tools, config.
 */

import type {
  Item,
  ItemId,
  ModelError,
  ModelRef,
  ModelRegistry,
  ReasoningEffort,
  ToolCallId,
  Usage,
} from '../model/index.js';
import type { ApprovalRequirement, NestedRunBudget, ToolRegistry, ToolResult, Workspace } from '../tools/index.js';
import type { SettingsReader } from '../config/index.js';

export type TurnId = string & { readonly __brand: 'TurnId' };
export type AgentId = string & { readonly __brand: 'AgentId' };
export type CheckpointId = string & { readonly __brand: 'CheckpointId' };

export type TurnBudget = NestedRunBudget;

export type TurnInput = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  /** Appended to history at the start of the turn. Empty for a retry. */
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  /** Names, not live tools: a checkpoint embeds this input and must stay plain data. */
  readonly toolNames: readonly string[];
  readonly workspace: Workspace;
  readonly budget: TurnBudget;
};

/**
 * Plain audit data. Adopted checkpoints release only a live parked turn;
 * they do not provide crash recovery.
 */
export type TurnCheckpoint = {
  readonly turnId: TurnId;
  readonly checkpointId?: CheckpointId;
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

export type ApprovalGrant =
  | 'allow-once'
  | 'allow-remember'
  | 'unsandboxed-once'
  | 'allow-folder-session'
  | 'allow-edit-file-session'
  | 'allow-edit-folder-session'
  | 'docker-allow-once'
  | 'docker-allow-session'
  | 'docker-allow-project';
export type ApprovalDecision = (
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason?: string }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'grant'; readonly grant: ApprovalGrant }
) & { readonly stopAfterApprovalResolution?: boolean };

export type TurnOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'suspended'; readonly approvals: readonly ApprovalRequest[]; readonly checkpoint: TurnCheckpoint }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'failed'; readonly error: ModelError };

export type EngineEvent =
  | { readonly type: 'segment_started'; readonly segmentId: string }
  | { readonly type: 'segment_committed'; readonly segmentId: string; readonly history: readonly Item[] }
  | { readonly type: 'tool_dispatched'; readonly callId: ToolCallId }
  | { readonly type: 'model_attempt_rollback'; readonly reasoningCharacters: number }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  /** A finished history item. The session log stores these; deltas are transient. */
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'tool_started'; readonly callId: ToolCallId; readonly toolName: string; readonly input: unknown }
  | { readonly type: 'tool_progress'; readonly callId: ToolCallId; readonly chunk: string }
  | { readonly type: 'tool_finished'; readonly callId: ToolCallId; readonly result: ToolResult }
  /** Audit evidence at a turn boundary; persistence does not guarantee resumption. */
  | { readonly type: 'checkpoint'; readonly checkpoint: TurnCheckpoint }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'retrying'; readonly attempt: number; readonly delayMs: number; readonly error: ModelError }
  | { readonly type: 'compacted'; readonly summaryId: ItemId; readonly replaced: number }
  | { readonly type: 'subagent'; readonly agentId: AgentId; readonly role: string; readonly event: EngineEvent }
  | { readonly type: 'turn_ended'; readonly outcome: TurnOutcome };

/** A view of a turn. Its last event is `turn_ended`; suspended views retain cancellation authority. */
export interface TurnRun {
  readonly turnId: TurnId;
  readonly events: AsyncIterable<EngineEvent>;
  cancel(): void;
}

export interface Engine {
  start(input: TurnInput): TurnRun;
  /** Continue a suspended turn. Adopted runs require the original live parked turn. */
  resume(checkpoint: TurnCheckpoint, decisions: ReadonlyMap<ToolCallId, ApprovalDecision>): TurnRun;
  dispose(): Promise<void>;
}

/** Live dependencies are injected once, so turn inputs and checkpoints stay serializable. */
export type EngineDeps = {
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly settings: SettingsReader;
};

export type CreateEngine = (deps: EngineDeps) => Engine;

export interface Compactor {
  /** Returns a shorter history with `summary` items standing in for older spans. */
  compact(history: readonly Item[], model: ModelRef, signal: AbortSignal): Promise<readonly Item[]>;
  shouldCompact(history: readonly Item[], model: ModelRef): boolean;
}
