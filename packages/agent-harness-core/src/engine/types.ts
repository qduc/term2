/** Direct runtime contracts. Live acceptance tokens are never persisted. */
import type {
  Item,
  ModelError,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  ModelAffinity,
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
  ToolInteractionRequest,
  ToolRegistry,
  ToolResult,
  NestedRunRequest,
  NestedRunResult,
} from '../tools/contracts.js';
import type { TurnId } from './index.js';
import type { DirectRecoveryOptions } from './recovery.js';
import type { DirectContinuity, DirectContinuityBinding } from './recovery-continuity.js';
import type {
  DirectCompactionSettings,
  DirectCompactionResult,
  DirectCompactionStart,
  DirectCompactionRequest,
} from './recovery-compaction.js';
import type { DirectContextEstimate } from './context-estimate.js';
import type {
  ModelRequestCost,
  RunBudget,
  RunBudgetEvent,
  RunBudgetPolicy,
  RunBudgetSnapshot,
} from './recovery-budget.js';

/** Replay metadata is promoted only with an accepted history replacement. */
export type TurnCompactionState = {
  readonly rearmAtEstimatedTokens?: number;
  readonly rearmAtRenderedTokens?: number;
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

export type { ExecutionId, InteractionDecision, InteractionRequestId } from '../tools/contracts.js';

export type TurnSpec = {
  readonly affinity?: ModelAffinity;
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
  /** Per-turn model and tool call caps, independent of the optional cost budget. */
  readonly limits?: { readonly maxModelCalls: number; readonly maxToolCalls: number };
};
export type DirectManualCompactionOutcome =
  /** Estimated rendered input tokens before and after, as legacy's manual compaction reports them. */
  | { readonly kind: 'compacted'; readonly tokensBefore: number; readonly tokensAfter: number }
  | { readonly kind: 'blocked'; readonly reason: string };
export type TurnResult =
  | { readonly kind: 'completed'; readonly notice?: string; readonly compaction?: DirectManualCompactionOutcome }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'interrupted';
      readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked' | 'budget_exhausted';
      readonly notice?: string;
    }
  | { readonly kind: 'failed'; readonly error: ModelError; readonly notice?: string };
export type InteractionRequest = ToolInteractionRequest & {
  readonly requestId: InteractionRequestId;
  readonly turnId: TurnId;
  readonly executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
};
/** Per-execution authority used by host-supplied app capabilities.
 * Accessors follow the active scripted leaf, rather than capturing its root. */
export type ToolContextBinding = {
  readonly turnId: TurnId;
  readonly parentExecutionId: ExecutionId;
  readonly signal: AbortSignal;
  assertActive(): void;
  assertCanStart(): void;
  parked(): void;
};
export type TurnDeps<AppCtx = unknown> = {
  /** Optional host pricing policy. Without it, provider charges are honored and unknown rates stay unpriced. */
  readonly accounting?: {
    readonly getPrice: import('../shared/cost/model-cost.js').ModelCostInput['getPrice'];
    readonly getPricingVersion?: (tier: ModelRequestCost['serviceTier']) => string | undefined;
    readonly isSubscriptionProvider?: (provider: string | undefined) => boolean;
  };
  /** Transient lifecycle, not a durable fact or response/first-token observation. */
  readonly onTurnBoundary?: (context: {
    readonly turnId: TurnId;
    readonly kind: 'request_dispatched' | 'parked' | 'ended' | 'cancelled';
  }) => void;
  readonly models: ModelRegistry;
  readonly tools?: ToolRegistry<AppCtx>;
  readonly toolContext?: AppCtx;
  /** Optional per-execution app capabilities. Throwing fails the turn before tool execution. */
  readonly createToolContext?: (binding: ToolContextBinding) => AppCtx;
  readonly maxParallelToolCalls?: number;
  readonly takeSteering?: (turnId: TurnId) => readonly Item[] | Promise<readonly Item[]>;
  readonly prepareRequest?: (
    request: ModelRequest,
    context: { readonly turnId: TurnId; readonly modelStep: number; readonly signal: AbortSignal },
  ) =>
    | { readonly request: ModelRequest; readonly tools?: ToolRegistry<AppCtx> }
    | Promise<{ readonly request: ModelRequest; readonly tools?: ToolRegistry<AppCtx> }>;
  /**
   * Session rollover milestone reminders due at a request boundary, from the last completed provider input tokens
   * (undefined when this turn has none yet). `settle` hands the turn's last value on to the next turn.
   */
  readonly contextMilestones?: {
    observe(lastInputTokens: number | undefined): readonly string[];
    settle(lastInputTokens: number | undefined): void;
  };
  /** Session-wide hold after a blocked or failed automatic compaction (legacy agent-client), across turns. */
  readonly compactionHold?: { rearmAt?: number };
  /** The application log, for the legacy warnings a turn writes (compaction blocked or failed). */
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
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
  /** Session owns task identity, branch receipts, interaction acceptance and transfers. */
  readonly runNested?: (
    request: NestedRunRequest,
    context: { readonly turnId: TurnId; readonly parentExecutionId: ExecutionId; readonly signal: AbortSignal },
  ) => Promise<NestedRunResult>;
};
/** One accepted start and at most one observed outcome per engine attempt.
 * Session supplies turn/branch/session identity and durable seq/at, never engine. */
export type TurnCompactionEvent =
  | ({ readonly type: 'compaction_started'; readonly compactionId: string } & DirectCompactionStart)
  | {
      readonly type: 'compaction_completed';
      readonly compactionId: string;
      readonly strategy: 'native' | 'local';
      readonly after: DirectContextEstimate;
      readonly durationMs: number;
      readonly requests: readonly DirectCompactionRequest[];
    }
  | {
      readonly type: 'compaction_failed';
      readonly compactionId: string;
      readonly failure:
        | { readonly kind: 'blocked'; readonly reason: Extract<DirectCompactionResult, { kind: 'blocked' }>['reason'] }
        | { readonly kind: 'interrupted'; readonly reason: 'budget_wrap_up' | 'budget_exhausted' }
        | { readonly kind: 'cancelled' }
        | { readonly kind: 'failed'; readonly error: ModelError };
      readonly durationMs: number;
      readonly requests: readonly DirectCompactionRequest[];
    };
export type TurnEvent =
  | { readonly type: 'codex_quota'; readonly quota: import('../model/index.js').CodexWeeklyQuota | null }
  /** Live-only: a retry the user is told about, with its backoff. */
  | {
      readonly type: 'retrying';
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      readonly error: ModelError;
      readonly toolName: 'turn' | 'conversation';
      readonly retryType: 'upstream' | 'connection_interrupted';
    }
  /** Live-only: the engine retries a failed model request (legacy's subagent retry observation). */
  | { readonly type: 'model_retrying'; readonly attempt: number; readonly maxRetries: number; readonly delayMs: number }
  | TurnCompactionEvent
  /** Live-only progress. The actual physical request scopes reused provider IDs. */
  | (ToolCallArgumentProgress & { readonly turnId: TurnId; readonly modelStep: number })
  | {
      readonly type: 'history_replaced';
      readonly history: readonly Item[];
      readonly reason: 'compaction';
      readonly compactionId?: string;
      readonly rearmAtEstimatedTokens?: number;
      readonly rearmAtRenderedTokens?: number;
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
  /**
   * One settled physical request's accounting, emitted only for a budgeted run. A physical outcome: the
   * request was paid for whether or not the turn survives, so it is delivered after cancellation too.
   */
  | { readonly type: 'request_cost'; readonly record: ModelRequestCost }
  | {
      readonly type: 'budget_required';
      readonly requestId: InteractionRequestId;
      readonly turnId: TurnId;
      readonly evidence: RunBudgetEvent;
      readonly snapshot: RunBudgetSnapshot;
    }
  /** `withdrawn` takes back this model step's partial text before a retry. */
  | { readonly type: 'text_delta'; readonly delta: string; readonly modelStep?: number; readonly withdrawn?: true }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  | { readonly type: 'item'; readonly item: Item; readonly executionId?: ExecutionId; readonly modelStep?: number }
  | {
      readonly type: 'usage';
      readonly usage: Usage;
      readonly modelStep?: number;
      readonly speed?: { readonly tps: number; readonly approximate: boolean };
    }
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
  /** Wake an in-flight text response after Session durably admits a steer. */
  steer(): void;
  cancel(): void;
};
