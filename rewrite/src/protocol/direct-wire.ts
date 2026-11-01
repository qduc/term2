/** Direct public protocol. No engine tokens, provider history or live callbacks cross this boundary.
 * The unprefixed exports in index.ts still serve the isolated bridge, not this runtime.
 */
import type { ModelRequestCost } from '../engine/direct-recovery-budget.js';

export const DIRECT_PROTOCOL_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WireModel = { readonly provider: string; readonly model: string };
export type WireContent =
  | { readonly type: 'text'; readonly text: string }
  /** data is raw RFC 4648 base64 bytes, NOT a data URI/path/URL. Provider policy stays Session-owned. */
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly detail?: string };
export type WireStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
export type WireUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number };
export type WireGrant = 'allow-remember' | 'unsandboxed-once' | 'allow-folder-session' | 'allow-edit-file-session' | 'allow-edit-folder-session' | 'docker-allow-once' | 'docker-allow-session' | 'docker-allow-project';
export type WireQuestion = { readonly id: string; readonly prompt: string; readonly options: readonly { readonly label: string; readonly description?: string }[]; readonly multiple: boolean; readonly allowCustom: boolean };
export type WireQuestionAnswer = { readonly questionId: string; readonly value: string | readonly string[] };
export type WireDecision = (
  | { readonly kind: 'allow' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'answer'; readonly answer: string }
  | { readonly kind: 'answers'; readonly answers: readonly WireQuestionAnswer[] }
  | { readonly kind: 'grant'; readonly grant: WireGrant }
) & { readonly stopAfterApprovalResolution?: boolean };
export type WireInteraction = {
  readonly requestId: string;
  readonly turnId: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly taskId?: string;
  /** Accepted task descriptor ownership, independent of the child request turn. */
  readonly taskOwner?: WireTaskOwner;
  readonly sessionId?: string;
  readonly origin?: WireOrigin;
  readonly kind: 'approval' | 'question';
  readonly toolName: string;
  readonly input: JsonValue;
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly presentation?: { readonly [key: string]: JsonValue };
  readonly questions?: readonly WireQuestion[];
  /** Only explicitly supported grants may be offered; empty under the M2 contract. */
  readonly supportedGrants: readonly WireGrant[];
};
export type WireMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: readonly WireContent[];
  readonly text: string;
  readonly turnId?: string;
  readonly modelStep?: number;
  readonly executionId?: string;
  readonly isError?: boolean;
  readonly draft?: boolean;
  readonly replacesDraftId?: string;
};
export type WireTool = {
  readonly executionId: string;
  readonly turnId: string;
  readonly parentExecutionId?: string;
  readonly callId?: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly status: 'called' | 'started' | 'completed' | 'unknown';
  readonly output?: string;
  readonly isError?: boolean;
  readonly progress?: string;
  readonly display?: JsonValue;
  readonly content?: readonly WireContent[];
};
export type WireToolResult = { readonly executionId: string;
  /** Original accepted call metadata, available even when reconnect starts after the call frame. */
  readonly toolName?: string; readonly input?: JsonValue; readonly callId?: string; readonly parentExecutionId?: string; readonly output: string; readonly isError: boolean; readonly display?: JsonValue; readonly content?: readonly WireContent[] };
export type WireOrigin =
  | { readonly kind: 'cli' | 'tui' | 'acp' | 'api'; readonly id?: string }
  | { readonly kind: 'control'; readonly id?: string; readonly source?: 'orchestrator' }
  | { readonly kind: 'discord'; readonly source: 'human' | 'agent' | 'reaction'; readonly sender: string; readonly discordMessageId?: string; readonly relayedBy?: string };
export type WireAdmission =
  | { readonly kind: 'started' | 'queued' | 'steering'; readonly clientRequestId: string; readonly messageId: string; readonly turnId?: string }
  | { readonly kind: 'duplicate'; readonly clientRequestId: string; readonly original: Exclude<WireAdmission, { readonly kind: 'duplicate' }> }
  | { readonly kind: 'rejected'; readonly clientRequestId: string; readonly reason: string };
export type WireQueueEntry = { readonly messageId: string; readonly text: string; readonly delivery: 'queued' | 'steering'; readonly clientRequestId: string; readonly content?: readonly WireContent[]; readonly origin?: WireOrigin; readonly receivedAt?: string; readonly turnId?: string };
export type WireSubmissionRecord = {
  readonly clientRequestId: string; readonly messageId: string;
  readonly delivery: 'steer' | 'follow_up' | 'reject_if_busy'; readonly origin?: WireOrigin;
  readonly receivedAt: string; readonly originalContent: readonly WireContent[]; readonly content: readonly WireContent[];
  readonly admission: WireAdmission;
  readonly stage: 'queued' | 'pending_steer' | 'running' | 'steered' | 'finished' | 'retracted' | 'discarded' | 'cancelled';
  readonly turnId?: string; readonly outcome?: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  /** null means the accepted projection lacks a correlated completed answer. */
  readonly finalText: string | null;
};
/** Exact native queue boundary, not one fabricated event per affected reservation. */
export type WireQueueChange =
  | { readonly type: 'queue_submitted'; readonly record: WireSubmissionRecord }
  | { readonly type: 'queue_edited'; readonly messageId: string; readonly content: readonly WireContent[] }
  | { readonly type: 'queue_retracted'; readonly messageId: string }
  | { readonly type: 'queue_discarded'; readonly messageIds: readonly string[] }
  | { readonly type: 'queue_started'; readonly messageId: string; readonly turnId: string }
  | { readonly type: 'queue_steered'; readonly messageIds: readonly string[]; readonly turnId: string }
  | { readonly type: 'queue_cancelling'; readonly turnId: string; readonly cancelledMessageIds: readonly string[]; readonly retainedMessageIds: readonly string[] }
  | { readonly type: 'queue_settled'; readonly turnId: string; readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted'; readonly preservePendingSteers?: boolean }
  | { readonly type: 'queue_resumed' }
  | { readonly type: 'queue_recovered' };
export type WireTerminal = { readonly finalText?: string | null; readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted'; readonly error?: WireError; readonly terminalCause?: string; readonly notice?: string };
/** Public budget evidence, copied from accepted native observations, not a cost quote. */
export type WireAnswerProvenance = { readonly source: 'user' | 'policy' | 'system'; readonly automaticApproval?: boolean };
export type WireBudgetEvidence =
  | { readonly type: 'budget_stage'; readonly stage: 'soft' | 'warning' | 'critical'; readonly evidence: { readonly dimension: 'usd' | 'unpriced_tokens' | 'active_time' | 'turns'; readonly used: number; readonly limit: number; readonly headroom: number } }
  | { readonly type: 'tool_stall'; readonly toolName: string; readonly argumentsText: string; readonly count: number; readonly threshold: number };
export type WireBudgetSnapshot = { readonly pricedUsdMicros: number; readonly unpricedTokens: number; readonly activeTimeMs: number; readonly turns: number; readonly extensionsGranted: number; readonly latchedStages: readonly ('soft' | 'warning' | 'critical')[] };
export type WireBudgetRequest = { readonly requestId: string; readonly turnId: string; readonly evidence: WireBudgetEvidence; readonly snapshot: WireBudgetSnapshot };
export type WireBudgetDecision =
  | { readonly kind: 'extend'; readonly grantedBy: 'human' | 'parent' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'steer'; readonly items: readonly { readonly type: 'user_message'; readonly id: string; readonly content: readonly WireContent[] }[] };
export type WireBudgetResolution = Exclude<WireBudgetDecision, { readonly kind: 'steer' }> | { readonly kind: 'steer'; readonly messages: readonly WireMessage[] };
export type WireTurnResult = { readonly turnId: string; readonly messages: readonly WireMessage[] } & WireTerminal;
/** Physical request accounting retains the actual producing turn and immutable tree ownership.
 * A late child/summary/failure charge is not another root model response or terminal.
 */
export type WireRequestCost = {
  readonly turnId: string;
  readonly rootTurnId: string;
  readonly parentTurnId?: string;
  readonly record: Readonly<ModelRequestCost>;
};
export type WireToolUseCount = { readonly toolName: string; readonly count: number };
export type WireTaskResult = {
  readonly kind: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly output?: string;
  /** Actual accepted branch-local physical starts; absent means unknown, [] means none. */
  readonly toolUseCounts?: readonly WireToolUseCount[];
  readonly error?: WireError;
  readonly reason?: string;
};
export type WireTask = {
  readonly id: string;
  /** Original parent identity, not evidence that the foreground is still running. */
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly parentExecutionId?: string;
  readonly sourceCallId?: string;
  readonly origin?: WireOrigin;
  readonly agentId?: string;
  readonly kind?: 'shell' | 'subagent';
  readonly label?: string;
  /** Original task input supplied by its launcher. Absent means unknown. */
  readonly input?: string;
  readonly name?: string;
  readonly role?: string;
  readonly model?: WireModel;
  readonly mode?: 'foreground' | 'background';
  readonly status: 'running' | 'awaiting_interaction' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly completedAt?: number;
  readonly text?: string;
  readonly progress?: string;
  readonly result?: WireTaskResult;
};
/** Public task descriptor ownership; does not imply the parent foreground still runs. */
export type WireTaskOwner = Pick<WireTask, 'id' | 'turnId' | 'sessionId' | 'parentExecutionId' | 'sourceCallId' | 'origin' | 'kind' | 'name' | 'role'>;
export type WireRetry = { readonly turn: boolean; readonly tool: boolean };
export type WireError = { readonly kind: string; readonly message: string; readonly retryable?: boolean };
export type WireNotice = { readonly kind: string; readonly message: string };
export type WireGoal = { readonly id: string; readonly text: string; readonly successCriteria?: string; readonly status: 'active' | 'blocked' | 'completed' | 'cancelled' | 'achieved' | 'abandoned' };
export type WireVerification = {
  readonly status: 'pending' | 'running' | 'passed' | 'blocked' | 'failed'; readonly message?: string;
  readonly attemptId?: string; readonly goalGeneration?: number; readonly revision?: string;
  readonly report?: { readonly outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR' | 'TIMEOUT'; readonly evidence: string; readonly checked: readonly string[]; readonly limitations: readonly string[]; readonly verifierVersion: string };
};
export type WireConfiguration = { readonly model?: WireModel; readonly reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; readonly temperature?: number };
/** Requested configure selection only. Accepted output uses WireConfiguration. */
export type WireConfigureRequest = {
  readonly model?: WireModel;
  readonly reasoning?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly temperature?: number;
  readonly profileId?: string;
};
/** Public reset boundary for a physical log rotation under one stable logical session.
 * It names the new physical header without exposing provider history or raw facts. */
export type WireSessionRotation = {
  readonly logicalSessionId: string;
  readonly backingSessionId: string;
  readonly predecessor: { readonly sessionId: string; readonly throughSeq: number };
  readonly commandId: string;
  readonly configuration: WireConfiguration & { readonly model: WireModel };
  readonly handoff?: { readonly clientRequestId: string; readonly messageId: string; readonly turnId: string };
};
export type WireCancelTarget = { readonly kind: 'foreground' } | { readonly kind: 'task'; readonly id: string };
export type WireRewindTarget = { readonly id: string; readonly label: string };

/** Stable per-invocation identity, never a command-kind key or a provider call ID. */
export type WireNativeCommandOperation =
  | { readonly kind: 'retry'; readonly target: 'turn' | 'tool'; readonly executionId?: string }
  | { readonly kind: 'compact' }
  | { readonly kind: 'configure'; readonly configuration: WireConfigureRequest }
  | { readonly kind: 'rewind'; readonly targetId: string }
  | { readonly kind: 'rollover' };
export type WireCommandPreconditions = { readonly admission?: 'idle'; readonly expectedRevision?: string };
export type WireNativeCommandRequest = { readonly commandId: string; readonly operation: WireNativeCommandOperation } & WireCommandPreconditions;
export type WireNativeCommandOutcome =
  | { readonly kind: 'retried'; readonly turnId: string }
  | { readonly kind: 'rewound'; readonly draft: { readonly content: readonly WireContent[] } }
  | { readonly kind: 'compacted' }
  | { readonly kind: 'configured'; readonly configuration: WireConfiguration & { readonly model: WireModel } }
  | { readonly kind: 'rolled_over'; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly code: 'ineligible' | 'stale' | 'busy' | 'unavailable' | 'cancelled' | 'failed'; readonly message: string }
  | { readonly kind: 'interrupted'; readonly reason: 'outcome_unobserved' };
export type WireCommandReceipt = { readonly request: WireNativeCommandRequest; readonly revision: string; readonly outcome?: WireNativeCommandOutcome };
/** Accepted Session planning notices; deliveries identify actual silent turns. */
export type WireBackgroundNotice = { readonly id: string; readonly kind: 'completion' | 'control' | 'check_in'; readonly taskIds: readonly string[]; readonly text: string };
export type WireNoticeDelivery = { readonly clientRequestId: string; readonly turnId: string; readonly notificationIds: readonly string[] };
export type WireNotifications = { readonly notices: readonly WireBackgroundNotice[]; readonly deliveries: readonly WireNoticeDelivery[] };
export type WireNotificationDrainResult =
  | { readonly kind: 'started' | 'duplicate'; readonly turnId: string; readonly notificationIds: readonly string[] }
  | { readonly kind: 'empty' | 'busy' }
  | { readonly kind: 'not_admitting'; readonly reason: string };

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
  readonly reasoning: string;
  readonly reasoningIdentity?: { readonly messageId: string; readonly turnId: string | null; readonly modelStep: number | null } | null;
  readonly retryEligibility: WireRetry;
  readonly queue: readonly WireQueueEntry[];
  readonly queueState: 'idle' | 'running' | 'paused' | 'cancelling' | 'completing' | 'awaiting_action' | 'awaiting_preflight';
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
  /** null means the facade cannot yet supply authoritative mixed transcript ordering. */
  readonly timeline: readonly { readonly kind: 'message' | 'tool'; readonly id: string }[] | null;
};

export type WireEventPayloads = {
  snapshot: { readonly snapshot: WireSnapshot };
  turn_started: { readonly input: readonly WireMessage[]; readonly foreground: boolean; readonly silent?: true; readonly admission?: WireAdmission };
  text_delta: { readonly delta: string; readonly messageId: string; readonly modelStep: number };
  reasoning: { readonly text: string; readonly messageId: string; readonly modelStep: number | null };
  reasoning_delta: { readonly delta: string; readonly modelStep: number | null; readonly messageId: string | null };
  message: { readonly message: WireMessage; readonly replacesDraftId?: string };
  /** Live-only source-measured cumulative count; no execution or persisted tool item. */
  tool_call_streaming_delta: { readonly modelStep: number; readonly argumentCharCount: number; readonly toolName?: string; readonly callId?: string; readonly itemId?: string; readonly callIndex?: number };
  tool_called: { readonly tool: WireTool };
  tool_started: { readonly tool: WireTool };
  tool_progress: { readonly executionId: string; readonly chunk: string };
  tool_finished: WireToolResult;
  interaction_opened: { readonly interaction: WireInteraction };
  interaction_resolved: { readonly taskId?: string; readonly taskOwner?: WireTaskOwner; readonly requestId: string; readonly resolution: WireDecision | { readonly kind: 'cancelled' | 'interrupted' }; readonly provenance?: WireAnswerProvenance };
  budget_opened: { readonly request: WireBudgetRequest };
  budget_closed: { readonly requestId: string; readonly decision: WireBudgetResolution; readonly source: 'user' | 'parent' | 'system' };
  budget_observed: { readonly evidence: WireBudgetEvidence };
  history_replaced: { readonly reason: 'compaction' | 'retry_turn' | 'retry_tool' | 'rewind' };
  request_cost_recorded: WireRequestCost;
  /** One accepted successor boundary; clients clear foreground state at this seq. */
  session_rotated: WireSessionRotation;
  background_notice_enqueued: { readonly notice: WireBackgroundNotice };
  background_notices_delivered: WireNoticeDelivery;
  /** One accepted receipt fact, not proof a model/tool/successor completed. */
  command_started: { readonly receipt: WireCommandReceipt };
  command_finished: { readonly receipt: WireCommandReceipt & { readonly outcome: WireNativeCommandOutcome } };
  model_response_completed: { readonly modelStep: number; readonly stopReason: string; readonly costUsd?: number | string };
  admission: { readonly admission: WireAdmission };
  usage: { readonly usage: WireUsage };
  status_changed: { readonly status: WireStatus };
  turn_ended: WireTerminal;
  retrying: { readonly attempt: number; readonly delayMs: number; readonly error: WireError; readonly toolName?: string; readonly maxRetries?: number; readonly retryType?: string; readonly retryAfterMs?: number; readonly agentId?: string };
  retry_eligibility: WireRetry;
  configuration: WireConfiguration;
  queue_changed: { readonly change: WireQueueChange; readonly entries: readonly WireQueueEntry[]; readonly state: WireSnapshot['queueState']; readonly pauseReason?: WireSnapshot['queuePauseReason']; readonly admission?: WireAdmission; readonly messages?: readonly WireMessage[]; readonly submissions?: readonly WireSubmissionRecord[] };
  task_changed: { readonly change: 'task_started' | 'task_backgrounded' | 'task_stop_requested' | 'task_finished'; readonly at: number; readonly task: WireTask };
  task_progress: { readonly taskId: string; readonly at: number; readonly kind: 'text' | 'tool_progress' | 'activity'; readonly chunk: string; readonly executionId?: string };
  subagent: { readonly agentId: string; readonly branchId?: string; readonly parentTurnId?: string; readonly rootTurnId?: string; readonly role?: string; readonly event: WireEvent };
  compacted: { readonly replaced: number; readonly summaryId: string };
  cost: { readonly totalUsd: number; readonly currency: 'USD' };
  notice: WireNotice;
  /** Session-owned public command notice; no private memory snapshot/receipt is serialized. */
  automatic_memory_notice: { readonly success: boolean; readonly command: string; readonly output: string };
  goal: { readonly goal: WireGoal | null; readonly generation?: number };
  goal_proposed: { readonly goal: WireGoal };
  verification: { readonly verification: WireVerification | null };
  error: { readonly error: WireError };
};
export type WireEventType = keyof WireEventPayloads;
export type WireEvent = { [K in WireEventType]: {
  readonly sessionId: string;
  readonly seq: number | null;
  /** Original accepted FactLine.at, null/absent for transient or unavailable metadata. */
  readonly occurredAt?: string | null;
  readonly turnId: string | null;
  readonly type: K;
  readonly payload: WireEventPayloads[K];
} }[WireEventType];

export type WireSubmission = { readonly requestId: string; readonly text: string; readonly attachments?: readonly WireContent[]; readonly origin?: WireOrigin; readonly delivery?: 'auto' | 'steer' | 'follow_up' | 'reject_if_busy' };
export type WireCommand =
  | ({ readonly type: 'submit' } & WireSubmission)
  | { readonly type: 'answer'; readonly requestId: string; readonly decision: WireDecision; readonly provenance?: WireAnswerProvenance }
  | { readonly type: 'answer_budget'; readonly requestId: string; readonly decision: WireBudgetDecision; readonly provenance?: WireAnswerProvenance }
  | { readonly type: 'cancel'; readonly target?: WireCancelTarget; readonly expectedTurnId?: string; readonly discardQueue?: boolean }
  | ({ readonly type: 'retry'; readonly commandId: string; readonly target: 'turn' | 'tool'; readonly executionId?: string } & WireCommandPreconditions)
  | ({ readonly type: 'compact'; readonly commandId: string } & WireCommandPreconditions)
  | ({ readonly type: 'configure'; readonly commandId: string; readonly configuration: WireConfigureRequest } & WireCommandPreconditions)
  | { readonly type: 'queue_edit'; readonly messageId: string; readonly text: string; readonly attachments?: readonly WireContent[] }
  | { readonly type: 'queue_retract'; readonly messageId: string }
  | { readonly type: 'queue_resume' }
  | { readonly type: 'queue_discard' }
  | { readonly type: 'task_control'; readonly taskId: string; readonly action: 'cancel' | 'check_in' | 'foreground' | 'background' }
  | { readonly type: 'command_status'; readonly commandId: string }
  | { readonly type: 'command_revision' }
  | { readonly type: 'drain_background_notifications'; readonly requestId: string }
  | { readonly type: 'list_rewind_targets' }
  | ({ readonly type: 'rewind'; readonly commandId: string; readonly targetId: string } & WireCommandPreconditions)
  | { readonly type: 'reset' }
  | ({ readonly type: 'rollover'; readonly commandId: string } & WireCommandPreconditions)
  | { readonly type: 'preview'; readonly text: string; readonly attachments?: readonly WireContent[] };
export type WireCommandErrorCode = 'invalid_command' | 'unavailable' | 'stale_interaction' | 'request_conflict' | 'rejected' | 'closed' | 'not_found' | 'forbidden' | 'storage_failure' | 'too_late' | 'internal_error' | 'replay_unavailable' | 'not_admitting' | 'command_rejected' | 'command_interrupted';
export type WireCommandResult =
  | { readonly ok: true; readonly kind: 'admitted'; readonly admission: WireAdmission }
  | { readonly ok: true; readonly kind: 'accepted' }
  /** Exact admission/empty/busy result, not completion of the silent model turn. */
  | { readonly ok: true; readonly kind: 'background_drain'; readonly result: Exclude<WireNotificationDrainResult, { readonly kind: 'not_admitting' }> }
  /** Atomic Session receipt, not a terminal or a promise that physical cleanup finished. */
  | { readonly ok: true; readonly kind: 'abort'; readonly result:
      | { readonly kind: 'aborted'; readonly turnId: string; readonly discardedMessageIds: readonly string[] }
      | { readonly kind: 'no_op'; readonly turnId: string; readonly status: 'terminal_accepted' | 'cancellation_requested' | 'not_current'; readonly reason?: string }
      | { readonly kind: 'not_admitting'; readonly reason?: string } }
  | { readonly ok: true; readonly kind: 'rewind_targets'; readonly targets: readonly WireRewindTarget[] }
  | { readonly ok: true; readonly kind: 'preview'; readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }
  | { readonly ok: true; readonly kind: 'session_changed'; readonly sessionId: string }
  /** Current native root-history/configuration revision for atomic mutations. */
  | { readonly ok: true; readonly kind: 'command_revision'; readonly revision: string }
  /** Pending means receipt-owned work, not command success or turn completion. */
  | { readonly ok: true; readonly kind: 'command_pending'; readonly replayed?: boolean; readonly receipt: WireCommandReceipt }
  | { readonly ok: true; readonly kind: 'command_finished'; readonly replayed?: boolean; readonly receipt: WireCommandReceipt & { readonly outcome: Exclude<WireNativeCommandOutcome, { readonly kind: 'rejected' | 'interrupted' }> } }
  | { readonly ok: false; readonly code: 'command_rejected' | 'command_interrupted'; readonly replayed?: boolean; readonly commandId: string; readonly message: string; readonly receipt: WireCommandReceipt & { readonly outcome: WireNativeCommandOutcome } }
  | { readonly ok: false; readonly code: Exclude<WireCommandErrorCode, 'command_rejected' | 'command_interrupted'>; readonly message: string; readonly commandId?: string };
