import type { Term2HookScope } from '../../session/hooks/hook-contracts.js';
import type { ApplicationAgent, NestedApprovalLedger } from '../../shared/contracts/nested-run-driver.js';
import type { ProviderInput, ProviderInputItem } from '../../shared/contracts/provider-input.js';
import type { RunTerminationCause } from '../../shared/contracts/run-termination.js';
import type {
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
} from '../../shared/contracts/streamed-model-turn.js';
import { type ModelRequestCost } from '../../shared/cost/model-cost.js';
import type { RequestSnapshot } from '../../tools/types.js';
import { type AgentStream } from '../agent-stream.js';
import type { RetryRecoveryBudget } from '../retry/retry-recovery-budget.js';
import { takeRunBudgetGrant } from './run-budget-policy.js';
import { RunBudget, isRunBudgetInteraction, type RunBudgetEvent, type RunBudgetInteraction } from './run-budget.js';
import { normalizeHistory, normalizeInput } from './run-input.js';
import type {
  ApplicationRequestPreparation,
  ApplicationRunLoopOptions,
  ApplicationTurnSession,
} from './run-loop-contracts.js';
import type { PendingNativeReasoning } from './run-native-reasoning.js';
import { EventQueue } from './run-segment-events.js';
import { ToolCallExecution } from './tool-call-execution.js';
import { ApprovalLedger, type ToolInvocationContext } from './tool-invocation-context.js';
export type RunState = {
  completionRepairDeadline?: number;
  /** One live computation; continuation handles only reconnect its event view. */
  live?: RunContext;
  inputUsageInvalidatedByCompaction?: boolean;
  agent: ApplicationAgent;
  recoveryBudget?: RetryRecoveryBudget;
  input: StreamedModelTurnInput[];
  history: ProviderInputItem[];
  compactionHistory?: readonly ProviderInputItem[];
  usesDeltaHistory?: boolean;
  compactedDuringRun?: boolean;
  toolExecution: ToolCallExecution;
  approvalDecision?: 'approved' | 'rejected';
  approvalDecisionCallId?: string;
  /** The interruption object the decision answered; binds it to that exact pending call. */
  approvalDecisionInterruption?: unknown;
  approvalQueue?: Array<
    Readonly<{ callId: string | undefined; interruption: unknown; decision: 'approved' | 'rejected'; message?: string }>
  >;
  approvalMessage?: string;
  /** Snapshot of the latest provider request built; the calls its response plans keep it. */
  requestSnapshot?: RequestSnapshot;
  responseId?: string;
  usage?: unknown;
  /** Provider-reported input usage from the latest completed request. */
  lastCompletedInputTokens?: number;
  /** The run's user context (from options), preserved across continuation. */
  context?: unknown;
  /** This run's approval ledger, preserved across continuation. */
  approvals: NestedApprovalLedger;
  /** Model turns taken so far, preserved across continuation. */
  turnCount: number;
  /** Local automatic compactions already paid for in this run. */
  automaticCompactionsThisRun?: number;
  /** Eligibility advice is admitted once across this run's tool/approval continuations. */
  compactionNotice?: string;
  /** Turn budget for the run; undefined means unbounded. */
  maxTurns?: number;
  /** Per-run staged budget and deterministic stall sensor, retained across approval continuation. */
  runBudget?: RunBudget;
  onRunBudgetEvent?: (event: RunBudgetEvent) => void;
  wrapUpOnCriticalRunBudget?: boolean;
  /** Copied from the run-budget policy: 'warn' never pauses the run, 'disabled' emits no events. */
  runBudgetEscalation?: 'contain' | 'warn' | 'pause' | 'disabled';
  criticalWrapUpPending?: boolean;
  criticalWrapUpDispatched?: boolean;
  /** Main-agent evidence that must be resolved before another request or tool dispatch. */
  pendingRunBudgetInteraction?: RunBudgetInteraction;
  runBudgetInteractionDecision?: 'continue' | 'stop';
  /** Whether the current interaction's finite extension has already been taken. */
  runBudgetGrantConsumed?: boolean;
  /** Cumulative model-request cost records for this run, preserved across continuation. */
  costRecords?: ModelRequestCost[];
  /** Keep provider response IDs out of requests for providers that do not support them. */
  supportsConversationChaining: boolean;
  /** One-shot: the next model request must be a fresh full-history inference. */
  disableChainingForAttempt?: boolean;
  /** Oversized tool-argument trips answered with a split-the-work notice in this run. */
  oversizedToolArgumentRecoveries?: number;
  /** Provider currently executing this continuation. */
  currentProviderId?: string;
  /** Provider that originated responseId; absent on legacy handles. */
  responseProviderId?: string;
  /** The logical run ended by containment, despite a valid provider response. */
  terminalCause?: RunTerminationCause;
  /** Root-only provider request preparation, retained by continuations. */
  requestPreparation?: ApplicationRequestPreparation;
  requestInputLimit?: () => number | null | undefined;
  sessionId?: string;
  turnId?: string;
  hookScope?: Term2HookScope;
  approve?: (_interruption?: unknown) => void;
  reject?: (_interruption?: unknown, options?: { message?: string }) => void;
};

export type ModelToolCall = Extract<StreamedModelTurnEvent, { type: 'tool_call' }>;
export type RunContext = {
  completionRepairExpired?: boolean;
  session?: ApplicationTurnSession;
  turnSignal?: AbortSignal;
  observation?: Promise<void>;
  state: RunState;
  stream: AgentStream & { finalOutput?: string };
  queue: EventQueue;
  options: ApplicationRunLoopOptions;
  toolContext: ToolInvocationContext;
  requestAbortController: AbortController;
  generation: number;
  resolveSegment: (value: unknown) => void;
  rejectSegment: (error: unknown) => void;
  resume?: () => void;
};
export type ModelExchange = {
  streamedToolCalls: ModelToolCall[];
  completion?: Extract<StreamedModelTurnEvent, { type: 'completion' }>;
  sawToolCall: boolean;
  activeRequestId: string;
  activeRequest?: StreamedModelTurnRequest;
  pendingNativeReasoning?: PendingNativeReasoning;
  deferredNativeReasoning: PendingNativeReasoning[];
  criticalWrapUp: boolean;
};
/** Initialize one logical run; continuations retain its budget, approval and request state. */
export function createRunState(
  agent: ApplicationAgent,
  input: ProviderInput,
  options: ApplicationRunLoopOptions,
  toolExecution: ToolCallExecution,
): RunState {
  const state: RunState = {
    agent,
    toolExecution: toolExecution,
    recoveryBudget: options.recoveryBudget,
    input: normalizeInput(input),
    history: normalizeHistory(input),
    compactionHistory: options.compactionHistory,
    usesDeltaHistory: Boolean(options.previousResponseId) && options.disableChainingForAttempt !== true,
    // A response ID is usable only after its provider origin is recorded.
    // This also makes old callers that omit providerId fail closed.
    responseId:
      options.disableChainingForAttempt !== true && options.providerId && options.supportsConversationChaining === true
        ? options.previousResponseId ?? undefined
        : undefined,
    supportsConversationChaining: options.supportsConversationChaining === true,
    currentProviderId: options.providerId,
    responseProviderId:
      options.providerId && options.supportsConversationChaining === true && options.previousResponseId
        ? options.providerId
        : undefined,
    requestPreparation: options.requestPreparation,
    requestInputLimit: options.requestInputLimit,
    disableChainingForAttempt: options.disableChainingForAttempt === true,
    sessionId: options.sessionId,
    turnId: options.turnId,
    hookScope: options.hookScope,
    context: options.context,
    approvals: options.approvals ?? new ApprovalLedger(),
    turnCount: 0,
    maxTurns: options.maxTurns,
    completionRepairDeadline: options.completionRepairDeadline,
    ...(options.runBudget
      ? {
          runBudget: new RunBudget(options.runBudget),
          onRunBudgetEvent: options.onRunBudgetEvent,
          wrapUpOnCriticalRunBudget: options.wrapUpOnCriticalRunBudget,
          runBudgetEscalation: options.runBudget.escalation,
        }
      : {}),
    automaticCompactionsThisRun: 0,
  };
  state.approve = (interruption) => {
    if (isRunBudgetInteraction(interruption)) {
      // Continuing past an exhausted envelope must cost a finite extension no
      // matter which surface answered. A caller that already took the grant
      // (the interactive prompt, which needs the outcome before resuming)
      // marks it consumed; every other path — the continuation applier,
      // non-interactive, --auto-approve — lands here ungranted and takes it
      // now. Without this, an auto-approved 'y' would resume with every stage
      // still latched and never check in again.
      state.runBudgetInteractionDecision = takeRunBudgetGrant(state) ? 'continue' : 'stop';
      return;
    }
    if (state.approvalQueue) {
      state.approvalQueue.push(
        Object.freeze({ callId: getInterruptionCallId(interruption), interruption, decision: 'approved' }),
      );
      return;
    }
    state.approvalDecision = 'approved';
    state.approvalDecisionCallId = getInterruptionCallId(interruption);
    state.approvalDecisionInterruption = interruption;
  };
  state.reject = (interruption, approvalOptions) => {
    if (isRunBudgetInteraction(interruption)) {
      state.runBudgetInteractionDecision = 'stop';
      return;
    }
    if (state.approvalQueue) {
      state.approvalQueue.push(
        Object.freeze({
          callId: getInterruptionCallId(interruption),
          interruption,
          decision: 'rejected',
          message: approvalOptions?.message,
        }),
      );
      return;
    }
    state.approvalDecision = 'rejected';
    state.approvalDecisionCallId = getInterruptionCallId(interruption);
    state.approvalDecisionInterruption = interruption;
    state.approvalMessage = approvalOptions?.message;
  };
  return state;
}
/** Refresh only provider/session context; never reset run accounting across an approval pause. */
export function refreshContinuation(state: RunState, options: ApplicationRunLoopOptions): void {
  if (!state.runBudget && options.runBudget) {
    state.runBudget = new RunBudget(options.runBudget);
  }
  if (options.runBudget) state.runBudgetEscalation = options.runBudget.escalation;
  if (options.onRunBudgetEvent) state.onRunBudgetEvent = options.onRunBudgetEvent;
  if (options.wrapUpOnCriticalRunBudget) state.wrapUpOnCriticalRunBudget = true;
  // Response IDs are provider-owned. A handle from before provenance was
  // recorded, a missing providerId, or a provider switch must never forward
  // its opaque ID. In particular, do not use previousResponseId as a
  // compatibility fallback here: its origin cannot be proven.
  const previousProviderId = state.currentProviderId;
  const sameProvider =
    typeof previousProviderId === 'string' &&
    typeof options.providerId === 'string' &&
    previousProviderId === options.providerId;
  if (!sameProvider || options.supportsConversationChaining !== true) {
    state.responseId = undefined;
    state.responseProviderId = undefined;
  } else if (options.previousResponseId) {
    // A same-provider caller may supply a refreshed continuity anchor (for
    // example after persisted-session recovery). Its origin is now proven
    // by the provider identity carried in this continuation state.
    state.responseId = options.previousResponseId;
    state.responseProviderId = options.providerId;
  }
  state.currentProviderId = options.providerId;
  // The turn budget belongs to the run, so a resumed run keeps spending the
  // same one rather than starting over after every approval pause.
  if (typeof state.turnCount !== 'number') state.turnCount = 0;
  if (state.maxTurns === undefined) state.maxTurns = options.maxTurns;
  state.supportsConversationChaining = options.supportsConversationChaining === true;
  // A continuation receives a fresh immutable snapshot from the session;
  // refresh the preparation closure when supplied, while preserving the
  // root closure for callers that do not provide one again.
  if (options.requestPreparation) state.requestPreparation = options.requestPreparation;
  if (options.requestInputLimit) state.requestInputLimit = options.requestInputLimit;
  if (options.compactionHistory) state.compactionHistory = options.compactionHistory;
  if (options.disableChainingForAttempt === true) {
    state.disableChainingForAttempt = true;
    state.responseId = undefined;
    state.responseProviderId = undefined;
  }
  if (options.sessionId !== undefined) state.sessionId = options.sessionId;
  if (options.turnId !== undefined) state.turnId = options.turnId;
  if (options.hookScope !== undefined) state.hookScope = options.hookScope;
}
function getInterruptionCallId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const callId = (value as { callId?: unknown }).callId;
  return typeof callId === 'string' ? callId : undefined;
}
