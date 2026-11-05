/** Public accepted read models and event envelopes, with no private engine capabilities. */
import type {
  DIRECT_PROTOCOL_VERSION,
  WireAdmission,
  WireAnswerProvenance,
  WireBackgroundNotice,
  WireBudgetEvidence,
  WireBudgetRequest,
  WireBudgetResolution,
  WireCommandReceipt,
  WireCompactionCompleted,
  WireCompactionFailed,
  WireCompactionStarted,
  WireConfiguration,
  WireDecision,
  WireError,
  WireGoal,
  WireInteraction,
  WireMessage,
  WireModel,
  WireNativeCommandOutcome,
  WireNotice,
  WireNoticeDelivery,
  WireNotifications,
  WireQueueChange,
  WireQueueEntry,
  WireRequestCost,
  WireRetry,
  WireSessionRotation,
  WireStatus,
  WireSubmissionRecord,
  WireTask,
  WireTaskOwner,
  WireTerminal,
  WireTool,
  WireToolResult,
  WireTurnResult,
  WireUsage,
  WireVerification,
} from './direct-wire.js';

/** seq is a durable cursor, never the Session's private publication position.
 * null means no durable cursor is available (for example a transient-only state).
 */
export type WireSnapshot = {
  readonly protocolVersion: typeof DIRECT_PROTOCOL_VERSION;
  readonly sessionId: string;
  /** Actual current physical log; sessionId remains the stable logical facade. */
  readonly backingSessionId: string;
  readonly seq: number | null;
  readonly status: WireStatus;
  readonly model: WireModel;
  readonly configuration: WireConfiguration;
  readonly activeTurnId: string | null;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly WireTool[];
  /** Accepted branch read models at this outer seq; absent means unsupported, not empty history. */
  readonly branches?: readonly WireBranchSnapshot[];
  /** Results without accepted call metadata are retained, never assigned an invented tool name. */
  readonly unmatchedToolResults?: readonly WireToolResult[];
  readonly pendingInteractions: readonly WireInteraction[];
  readonly pendingBudgets?: readonly WireBudgetRequest[];
  readonly turnResults?: readonly WireTurnResult[];
  readonly requestCosts?: readonly WireRequestCost[];
  readonly commands?: readonly WireCommandReceipt[];
  readonly notifications?: WireNotifications;
  readonly budgetObservations?: readonly { readonly turnId: string | null; readonly evidence: WireBudgetEvidence }[];
  readonly admissions: readonly WireAdmission[];
  readonly submissions?: readonly WireSubmissionRecord[];
  readonly usage: WireUsage;
  readonly lastUsage?: WireUsage;
  readonly lastSpeed?: { readonly tps: number; readonly approximate: boolean };
  readonly codexQuota?: import('../model/index.js').CodexWeeklyQuota;
  /** Live backoff before a retry the user is told about; cleared by the next output or terminal. */
  readonly retry?: {
    readonly id: number;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
  };
  readonly reasoning: string;
  readonly reasoningIdentity?: {
    readonly messageId: string;
    readonly turnId: string | null;
    readonly modelStep: number | null;
  } | null;
  readonly retryEligibility: WireRetry;
  readonly queue: readonly WireQueueEntry[];
  readonly queueState:
    | 'idle'
    | 'running'
    | 'paused'
    | 'cancelling'
    | 'completing'
    | 'awaiting_action'
    | 'awaiting_preflight';
  readonly queuePauseReason?: 'manual' | 'failure' | 'recovered_interrupted' | null;
  readonly tasks: readonly WireTask[];
  readonly cost: { readonly totalUsd: number; readonly currency: 'USD' } | null;
  readonly goal: WireGoal | null;
  readonly goalProposal?: WireGoal | null;
  readonly goalGeneration?: number;
  readonly verification: WireVerification | null;
  readonly notices: readonly WireNotice[];
  readonly lastError: WireError | null;
  readonly terminal: ({ readonly turnId: string } & WireTerminal) | null;
  /** First accepted display positions. Tool IDs resolve to tools or unmatched
   * results by real executionId; a result slot does not imply a call/start/name.
   * null means authoritative mixed transcript ordering is unavailable. */
  readonly timeline: readonly { readonly kind: 'message' | 'tool'; readonly id: string }[] | null;
};

/** Accepted public child evidence at the enclosing logical Session's single cut.
 * No child configuration/model/queue is inferred from the root. Raw live-only
 * reasoning/progress are not replayable through this read model.
 */
export type WireBranchSnapshot = {
  readonly branchId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
  /** Last actual branch_started/branch_event seq, not an independent resume cursor.
   * Joined task interactions/costs may be newer, up to the enclosing snapshot.seq.
   */
  readonly acceptedSeq: number;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly WireTool[];
  readonly unmatchedToolResults: readonly WireToolResult[];
  readonly timeline: WireSnapshot['timeline'];
  readonly pendingInteractions: readonly WireInteraction[];
  readonly pendingBudgets: readonly WireBudgetRequest[];
  readonly turnResults: readonly WireTurnResult[];
  /** Actual accepted child observations; null until a usage fact exists, never estimated. */
  readonly usage: WireUsage | null;
  /** Accepted summaries only; null until a summary exists, not a recovered live prefix. */
  readonly reasoning: string | null;
  readonly reasoningIdentity: NonNullable<WireSnapshot['reasoningIdentity']> | null;
  readonly terminal: WireSnapshot['terminal'];
  readonly notices: readonly WireNotice[];
  /** Same physical records selected by producing turnId; never additional charges. */
  readonly requestCosts: readonly WireRequestCost[];
  /** No branch queue fact producer exists; null is unavailable, not an empty queue. */
  readonly queue: null;
};

export type WireEventPayloads = {
  snapshot: { readonly snapshot: WireSnapshot };
  turn_started: {
    readonly input: readonly WireMessage[];
    readonly foreground: boolean;
    readonly silent?: true;
    readonly admission?: WireAdmission;
  };
  text_delta: { readonly delta: string; readonly messageId: string; readonly modelStep: number };
  reasoning: { readonly text: string; readonly messageId: string; readonly modelStep: number | null };
  reasoning_delta: { readonly delta: string; readonly modelStep: number | null; readonly messageId: string | null };
  codex_quota: { readonly quota: import('../model/index.js').CodexWeeklyQuota | null };
  message: { readonly message: WireMessage; readonly replacesDraftId?: string };
  /** Live-only source-measured cumulative count; no execution or persisted tool item. */
  tool_call_streaming_delta: {
    readonly modelStep: number;
    readonly argumentCharCount: number;
    readonly toolName?: string;
    readonly callId?: string;
    readonly itemId?: string;
    readonly callIndex?: number;
  };
  tool_called: { readonly tool: WireTool };
  tool_started: { readonly tool: WireTool };
  tool_progress: { readonly executionId: string; readonly chunk: string };
  tool_finished: WireToolResult;
  interaction_opened: { readonly interaction: WireInteraction };
  interaction_resolved: {
    readonly taskId?: string;
    readonly taskOwner?: WireTaskOwner;
    readonly requestId: string;
    readonly resolution: WireDecision | { readonly kind: 'cancelled' | 'interrupted' };
    readonly provenance?: WireAnswerProvenance;
  };
  budget_opened: { readonly request: WireBudgetRequest };
  budget_closed: {
    readonly requestId: string;
    readonly decision: WireBudgetResolution;
    readonly source: 'user' | 'parent' | 'system';
  };
  budget_observed: { readonly evidence: WireBudgetEvidence };
  history_replaced: {
    readonly retainTranscript?: true;
    readonly reason: 'compaction' | 'retry_turn' | 'retry_tool' | 'rewind';
    readonly compactionId?: string;
  };
  request_cost_recorded: WireRequestCost;
  /** One accepted attempt boundary; estimates are not measured usage. */
  compaction_started: WireCompactionStarted;
  compaction_completed: WireCompactionCompleted;
  compaction_failed: WireCompactionFailed;
  /** One accepted successor boundary; clients clear foreground state at this seq. */
  session_rotated: WireSessionRotation;
  background_notice_enqueued: { readonly notice: WireBackgroundNotice };
  background_notices_delivered: WireNoticeDelivery;
  /** One accepted receipt fact, not proof a model/tool/successor completed. */
  command_started: { readonly receipt: WireCommandReceipt };
  command_finished: { readonly receipt: WireCommandReceipt & { readonly outcome: WireNativeCommandOutcome } };
  model_response_completed: {
    readonly modelStep: number;
    readonly stopReason: string;
    readonly costUsd?: number | string;
  };
  admission: { readonly admission: WireAdmission };
  usage: { readonly usage: WireUsage; readonly speed?: { readonly tps: number; readonly approximate: boolean } };
  status_changed: { readonly status: WireStatus };
  turn_ended: WireTerminal;
  retrying: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: WireError;
    readonly toolName?: string;
    readonly maxRetries?: number;
    readonly retryType?: string;
    readonly retryAfterMs?: number;
    readonly agentId?: string;
  };
  retry_eligibility: WireRetry;
  configuration: WireConfiguration;
  queue_changed: {
    readonly change: WireQueueChange;
    readonly entries: readonly WireQueueEntry[];
    readonly state: WireSnapshot['queueState'];
    readonly pauseReason?: WireSnapshot['queuePauseReason'];
    readonly admission?: WireAdmission;
    readonly messages?: readonly WireMessage[];
    readonly submissions?: readonly WireSubmissionRecord[];
  };
  task_changed: {
    readonly change:
      | 'task_started'
      | 'task_backgrounded'
      | 'task_stop_requested'
      | 'task_finished'
      | 'task_question_opened'
      | 'task_question_closed';
    readonly at: number;
    readonly task: WireTask;
  };
  task_progress: {
    readonly taskId: string;
    readonly at: number;
    readonly kind: 'text' | 'tool_progress' | 'activity';
    readonly chunk: string;
    readonly executionId?: string;
  };
  subagent: {
    readonly agentId: string;
    readonly branchId?: string;
    readonly turnId?: string;
    readonly parentTurnId?: string;
    readonly rootTurnId?: string;
    readonly role?: string;
    readonly event: WireEvent;
  };
  compacted: { readonly replaced: number; readonly summaryId: string };
  cost: { readonly totalUsd: number; readonly currency: 'USD' };
  notice: WireNotice;
  /** Session-owned public command notice; no private memory snapshot/receipt is serialized. */
  automatic_memory_notice: { readonly success: boolean; readonly command: string; readonly output: string };
  /** Accepted goal-change provenance; clients must not infer self-check completion from status alone. */
  goal: {
    readonly goal: WireGoal | null;
    readonly generation?: number;
    readonly source?: 'user' | 'launcher' | 'proposal' | 'goal_check';
  };
  goal_proposed: { readonly goal: WireGoal };
  verification: { readonly verification: WireVerification | null };
  error: { readonly error: WireError };
};
export type WireEventType = keyof WireEventPayloads;
export type WireEvent = {
  [K in WireEventType]: {
    readonly sessionId: string;
    readonly seq: number | null;
    /** Original accepted FactLine.at, null/absent for transient or unavailable metadata. */
    readonly occurredAt?: string | null;
    readonly turnId: string | null;
    readonly type: K;
    readonly payload: WireEventPayloads[K];
  };
}[WireEventType];
