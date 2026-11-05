import type { ToolExecutionScope as Term2HookScope } from '../../tools/types.js';
import type { ApplicationRunEvent } from '../../shared/contracts/application-stream.js';
import type { ApplicationAgent, NestedApprovalLedger } from '../../shared/contracts/nested-run-driver.js';
import type { ProviderInput, ProviderInputItem } from '../../shared/contracts/provider-input.js';
import type { RunTerminationCause } from '../../shared/contracts/run-termination.js';
import type {
  ContextCompactionSessionState,
  StreamedModelTurn,
  StreamedModelTurnRequest,
} from '../../shared/contracts/streamed-model-turn.js';
import { type ModelRequestCost } from '../../shared/cost/model-cost.js';
import { MaxTurnsExceededError } from '../../tools/subagents/max-turns-error.js';
import type { ToolExecutionLifecyclePort } from '../../tools/types.js';
import { type AgentStream } from '../agent-stream.js';
import type { DecisionShadowObserver } from '../decision-shadow/decision-shadow-observer.js';
import type { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
import { type GenerationGuardOptions } from './generation-guard.js';
import { type RunBudgetEvent, type RunBudgetPolicy } from './run-budget.js';
export interface ApplicationRequestPreparation {
  /** Observe the exact application request immediately before model dispatch. */
  readonly prepare: (request: StreamedModelTurnRequest) => void;
  /** Keep request preparation context alive for the complete async model request. */
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface ApplicationBoundaryCompaction {
  readonly compact: (input: {
    history: readonly ProviderInputItem[];
    instructions?: string;
    tools?: unknown;
    /** Record paid summary requests before deciding whether another may run. */
    recordCostRecords?: (records: readonly ModelRequestCost[]) => boolean;
    automaticCompactionsThisRun: number;
    lastCompletedInputTokens?: number;
    signal?: AbortSignal;
    onStarted: (provider: string) => void;
  }) => Promise<
    | { kind: 'unchanged'; notice?: string }
    | { kind: 'failed'; provider: string; costRecords?: ModelRequestCost[]; error?: Error }
    | {
        kind: 'compacted';
        history: ProviderInputItem[];
        modelInput: ProviderInputItem[];
        costRecords?: ModelRequestCost[];
      }
  >;
}

export interface ApplicationRunLoopOptions {
  readonly signal?: AbortSignal;
  /** Shared automatic retry/recovery capability for this logical turn. */
  readonly recoveryBudget?: RetryRecoveryBudget;
  /** Existing provider response to continue from on the first model turn. */
  readonly previousResponseId?: string | null;
  /** Canonical session history for compaction when `input` is only a chained delta. */
  readonly compactionHistory?: readonly ProviderInputItem[];
  /** Skip previous_response_id and transport history compression for the next model request. */
  readonly disableChainingForAttempt?: boolean;
  /** Identity of the provider making this run. Required to establish response provenance. */
  readonly providerId?: string;
  /** Whether this provider accepts response IDs for continuation requests. */
  readonly supportsConversationChaining?: boolean;
  readonly sessionId?: string;
  /** Public hook correlation for the logical session turn. */
  readonly turnId?: string;
  /** Root/subagent ownership for observational tool events. */
  readonly hookScope?: Term2HookScope;
  /** Per-run user context delivered to tools as `ToolInvocationContext.context`. */
  readonly context?: unknown;
  /**
   * The run's approval ledger; a fresh one is created when omitted. Pass a
   * pre-seeded ledger to honor decisions already taken (e.g. parent approvals
   * replayed into a nested run — the F5 mechanism).
   */
  readonly approvals?: NestedApprovalLedger;
  /**
   * Legacy model-turn ceiling. With `runBudget`, the policy's `turnBackstop`
   * owns staged behavior while this value remains visible to legacy tools;
   * without one it preserves {@link MaxTurnsExceededError} compatibility.
   */
  readonly maxTurns?: number;
  /** Persisted completion-repair wall-clock boundary, independent of advisory run budgets. */
  readonly completionRepairDeadline?: number;
  /** Settings-backed staged containment policy. Omit only for legacy callers. */
  readonly runBudget?: RunBudgetPolicy;
  /** Observational escalation events; delivery and judgment remain outside the loop. */
  readonly onRunBudgetEvent?: (event: RunBudgetEvent) => void;
  /** Subagent containment: critical evidence gets one tool-free terminal call. */
  readonly wrapUpOnCriticalRunBudget?: boolean;
  /** Root-only provider request preparation, retained by continuations. */
  readonly requestPreparation?: ApplicationRequestPreparation;
  /** Application-owned local compaction evaluated at each request boundary. */
  readonly boundaryCompaction?: ApplicationBoundaryCompaction;
  /** Synchronous request-boundary policy, before any optional compaction await. */
  readonly onRequestBoundary?: (
    history: readonly ProviderInputItem[],
    onReminder: (text: string) => void,
    observation: {
      readonly lastCompletedInputTokens?: number;
      readonly compactionSkipReason?: 'missing_snapshot' | 'user_mismatch';
    },
  ) => { deferCompaction?: boolean } | void;
  /** Per-request output and deadline guard; model settings provide the normal runtime defaults. */
  readonly generationGuard?: GenerationGuardOptions;
  /** Live global ceiling, shared by root and transient/role clients. */
  readonly requestInputLimit?: () => number | null | undefined;
  /**
   * End the segment once the pending approval's tool result is in history,
   * instead of crossing the request boundary into another model call. The
   * segment then finishes with no interruptions, so it is terminal and its
   * history — the tool call *and* its result — is committed. Cancelling an
   * `ask_user` prompt uses this: the user gets the turn back, and the model
   * still sees that the question was asked and went unanswered.
   */
  readonly stopAfterApprovalResolution?: boolean;
  /**
   * Root-only policy consulted when a completed response would end the run
   * normally: no tool calls, no pending approval or budget interaction, no
   * cancellation, error, or containment wrap-up. `continue` queues its reminder
   * for the next request boundary and keeps the same run going, so budget,
   * steering, compaction, approval, and cancellation all apply as usual.
   */
  readonly onNormalStop?: (
    history: readonly ProviderInputItem[],
    agent: ApplicationAgent,
    signal: AbortSignal,
  ) => NormalStopDecision | Promise<NormalStopDecision>;
}

/** Bounded session operations. Only runTurn decides when execution advances. */
export interface ApplicationTurnSession {
  readonly approvalBatch?: true;
  readonly abortPendingModelReads?: true;
  readonly recordBudgetStopCause?: true;
  onDetachedModelRead?(operation: Promise<unknown>): void;
  prepare(signal: AbortSignal): Promise<
    | {
        agent: ApplicationAgent;
        input: ProviderInput;
        options: ApplicationRunLoopOptions;
      }
    | undefined
  >;
  /** Accept facts synchronously before observers or physical dispatch can advance. */
  beginSegment(stream: AgentStream): void;
  acceptEvent(event: ApplicationRunEvent): void;
  acceptToolDispatch(callId: string): void;
  onModelDispatch?(input: { readonly requestId: string; readonly providerId?: string; readonly model: string }): void;
  beforeToolDispatch?(callId: string): Promise<void>;
  isFatalError?(error: unknown): boolean;
  acceptSegment(stream: AgentStream): void;
  consume(stream: AgentStream): Promise<void>;
  interrupted(stream: AgentStream): Promise<ApplicationRunLoopOptions>;
  completed(stream: AgentStream): Promise<void>;
  recover(error: unknown): Promise<boolean>;
}

/** A normal-stop policy's answer; see `ApplicationRunLoopOptions.onNormalStop`. */
export type NormalStopDecision =
  | {
      readonly action: 'stop';
      readonly terminalCause?: RunTerminationCause;
      readonly notice?: string;
      readonly diagnostics?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly action: 'continue';
      readonly reminder: string;
      readonly repairDeadline?: number;
      readonly diagnostics?: Readonly<Record<string, unknown>>;
    };

export { MaxTurnsExceededError };

export interface ApplicationRunLoopDeps {
  readonly resolveModel: (model: string) => StreamedModelTurn | Promise<StreamedModelTurn>;
  readonly abortPendingModelReads?: true;
  readonly recordBudgetStopCause?: true;
  readonly onDetachedModelRead?: (operation: Promise<unknown>) => void;
  /** Root-only optional observation. It returns no policy; the run loop never awaits a Decisions response. */
  readonly decisionShadowObserver?: DecisionShadowObserver;
  readonly toolLifecycle?: ToolExecutionLifecyclePort;
  /**
   * Called when a tool body is about to run. Used by the session tool ledger to
   * mark dispatch so stream recovery can distinguish "never ran" from "outcome
   * unobserved". Resolved via getter so the session can wire the tracker after
   * the client is constructed.
   */
  /**
   * Resolves the conservative cap for independent calls from one response.
   * Read when settling a completed response so runtime settings apply at the
   * next request boundary; child budgets remain authoritative.
   */
  readonly resolveMaxParallelToolCalls?: () => number | undefined;
  /**
   * Diagnostics sink. Optional so no construction site or test has to supply
   * one. Used to report the fate of steers, which is otherwise invisible: a
   * turn spans several runs, and a steer only survives the run it was handed to.
   */
  readonly logDiagnostic?: (
    message: string,
    meta: Record<string, unknown>,
    options?: ApplicationRunLoopDiagnosticOptions,
  ) => void;
  readonly contextCompactionSessionState?: ContextCompactionSessionState;
  /** Injectable wait boundary so retry behavior can be tested without real timers. */
  readonly waitBeforeModelRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Explicit routing metadata for diagnostics emitted by the run loop. */
export type ApplicationRunLoopDiagnosticOptions = {
  readonly severity?: 'debug' | 'info';
  readonly eventType?: string;
};

/**
 * The fate of a message handed to `steer`/`retractSteer`/`editSteer`.
 *
 * `'admitted'` — the running turn took it at a request boundary.
 * `'released'` — no further boundary is coming (turn ending, or none
 * running); the caller must send it as its own turn instead.
 * `'retracted'` — `retractSteer` pulled it out before either of the above.
 */
export type SteerOutcome = 'admitted' | 'released' | 'retracted';
