/** Direct runtime contracts. Live acceptance tokens are never persisted. */
import type {
  Item,
  ModelError,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  ReasoningEffort,
  StopReason,
  ToolCallId,
  ToolCallArgumentProgress,
  ToolSpec,
  Usage,
} from '../model/index.js';
import type {
  ExecutionId,
  InteractionDecision,
  InteractionRequestId,
  ToolContext,
  ToolInteractionRequest,
  ToolRegistry,
  ToolResult,
  NestedRunRequest,
  NestedRunResult,
} from '../tools/index.js';
import type { TurnId } from './index.js';
import type { DirectRecoveryOptions } from './direct-recovery.js';
import type { DirectContinuity, DirectContinuityBinding } from './direct-recovery-continuity.js';
import type { DirectCompactionSettings } from './direct-recovery-compaction.js';
import type {
  ModelRequestCost,
  RunBudget,
  RunBudgetEvent,
  RunBudgetPolicy,
  RunBudgetSnapshot,
} from './direct-recovery-budget.js';

/** Replay metadata is promoted only with an accepted history replacement. */
export type TurnCompactionState = {
  readonly rearmAtEstimatedTokens?: number;
  readonly checkpointReceipts?: readonly string[];
};
export type BudgetDecision =
  | { readonly kind: 'extend'; readonly grantedBy: 'human' | 'parent' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'steer'; readonly items: readonly Item[] };
export type TurnBudget = {
  readonly policy: RunBudgetPolicy;
  readonly state?: RunBudget;
  /** Other accepted run/child costs; engine merges by stable requestId. */
  readonly costRecords?: (turnId: TurnId) => readonly ModelRequestCost[];
  /** Publish actual request accounting to the owning run/tree accumulator. */
  readonly onRequestCost?: (record: ModelRequestCost, context: { readonly turnId: TurnId }) => void;
  readonly wrapUpOnCritical?: boolean;
  /** Exact effect evidence, never inferred from a tool name or an error. */
  readonly toolEffect?: (name: string, input: unknown) => 'mutating' | undefined;
};
export type NormalStopDecision = {
  readonly action: 'stop' | 'continue';
  readonly reminder?: string;
  readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked';
  readonly notice?: string;
  readonly goalMarkedAchieved?: boolean;
};

export type { ExecutionId, InteractionDecision, InteractionRequestId } from '../tools/index.js';

export type TurnSpec = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly compactionState?: TurnCompactionState;
  /** Native branch admission only; root run-budget policy is separate. */
  readonly limits?: { readonly maxModelCalls: number; readonly maxToolCalls: number };
};
export type DirectManualCompactionOutcome =
  | { readonly kind: 'compacted' }
  | { readonly kind: 'blocked'; readonly reason: string };
export type TurnResult =
  | { readonly kind: 'completed'; readonly notice?: string; readonly compaction?: DirectManualCompactionOutcome }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'interrupted';
      readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked' | 'budget_exhausted';
      readonly notice?: string;
    }
  | { readonly kind: 'failed'; readonly error: ModelError };
export type InteractionRequest = ToolInteractionRequest & {
  readonly requestId: InteractionRequestId;
  readonly turnId: TurnId;
  readonly executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
};
export type ToolContextSeed = Pick<ToolContext, 'workspace' | 'settings'>;
export type TurnDeps = {
  readonly models: ModelRegistry;
  readonly tools?: ToolRegistry;
  readonly toolContext?: ToolContextSeed;
  readonly maxParallelToolCalls?: number;
  readonly takeSteering?: (turnId: TurnId) => readonly Item[] | Promise<readonly Item[]>;
  readonly prepareRequest?: (
    request: ModelRequest,
    context: { readonly turnId: TurnId; readonly modelStep: number; readonly signal: AbortSignal },
  ) =>
    | { readonly request: ModelRequest; readonly tools?: ToolRegistry }
    | Promise<{ readonly request: ModelRequest; readonly tools?: ToolRegistry }>;
  readonly normalStop?: (context: {
    readonly turnId: TurnId;
    readonly signal: AbortSignal;
  }) => Promise<NormalStopDecision>;
  readonly recovery?: DirectRecoveryOptions;
  readonly continuity?: { readonly binding: DirectContinuityBinding; readonly state?: DirectContinuity };
  readonly compaction?: {
    readonly settings: DirectCompactionSettings;
    readonly contextWindow?: number;
    readonly maxRequestInputTokens?: number | null;
  };
  readonly budget?: TurnBudget;
  /** Engine supplies current physical execution scope; Session retains the actual task registry. */
  readonly subagents?: (context: {
    readonly turnId: TurnId;
    readonly parentExecutionId: ExecutionId;
    readonly signal: AbortSignal;
  }) => NonNullable<ToolContext['subagents']>;
  /** Session owns task identity, branch receipts, interaction acceptance and transfers. */
  readonly runNested?: (
    request: NestedRunRequest,
    context: { readonly turnId: TurnId; readonly parentExecutionId: ExecutionId; readonly signal: AbortSignal },
  ) => Promise<NestedRunResult>;
};
export type TurnEvent =
  /** Live-only progress. The actual physical request scopes reused provider IDs. */
  | (ToolCallArgumentProgress & { readonly turnId: TurnId; readonly modelStep: number })
  | {
      readonly type: 'history_replaced';
      readonly history: readonly Item[];
      readonly reason: 'compaction';
      readonly rearmAtEstimatedTokens?: number;
      readonly checkpointReceipts?: readonly string[];
    }
  | {
      readonly type: 'model_response_completed';
      readonly modelStep: number;
      readonly stopReason: StopReason;
      readonly continuation?: unknown;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
      readonly costUsd?: number | string;
    }
  | { readonly type: 'budget_observed'; readonly evidence: RunBudgetEvent }
  | {
      readonly type: 'budget_required';
      readonly requestId: InteractionRequestId;
      readonly turnId: TurnId;
      readonly evidence: RunBudgetEvent;
      readonly snapshot: RunBudgetSnapshot;
    }
  | { readonly type: 'text_delta'; readonly delta: string; readonly modelStep?: number }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  | { readonly type: 'item'; readonly item: Item; readonly executionId?: ExecutionId; readonly modelStep?: number }
  | { readonly type: 'usage'; readonly usage: Usage; readonly modelStep?: number }
  | {
      readonly type: 'tool_called';
      readonly executionId: ExecutionId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_start_requested';
      readonly executionId: ExecutionId;
      readonly parentExecutionId?: ExecutionId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool_progress'; readonly executionId: ExecutionId; readonly chunk: string }
  | { readonly type: 'tool_execution_finished'; readonly executionId: ExecutionId; readonly result: ToolResult }
  | { readonly type: 'interaction_required'; readonly request: InteractionRequest }
  | { readonly type: 'turn_ended'; readonly result: TurnResult };
export type AcceptedTurnEvent = { readonly token: number; readonly event: TurnEvent };
/** Only Session accepts events, after their durable facts have committed. */
export type TurnHandle = {
  readonly events: AsyncIterable<AcceptedTurnEvent>;
  accept(token: number): void;
  answer(requestId: InteractionRequestId, decision: InteractionDecision): void;
  answerBudget(requestId: InteractionRequestId, decision: BudgetDecision): void;
  cancel(): void;
};
