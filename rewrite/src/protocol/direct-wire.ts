/** Direct public protocol. No engine tokens, provider history or live callbacks cross this boundary. */
import type { ModelRequestCost } from '../engine/direct-recovery-budget.js';
import type { DirectFinalWindow } from '../session/direct-final.js';

// Keep this public import path stable while envelopes have their own vocabulary owners.
export type { WireCommand, WireCommandErrorCode, WireCommandResult, WireSubmission } from './direct-wire-commands.js';
export type {
  WireBranchSnapshot,
  WireEvent,
  WireEventPayloads,
  WireEventType,
  WireSnapshot,
} from './direct-wire-events.js';

export const DIRECT_PROTOCOL_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WireModel = { readonly provider: string; readonly model: string };
export type WireContent =
  | { readonly type: 'text'; readonly text: string }
  /** data is raw RFC 4648 base64 bytes, NOT a data URI/path/URL. Provider policy stays Session-owned. */
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly detail?: string };
export type WireStatus = 'idle' | 'running' | 'awaiting_interaction' | 'interrupted' | 'closed';
export type WireUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};
export type WireGrant =
  | 'allow-remember'
  | 'unsandboxed-once'
  | 'allow-folder-session'
  | 'allow-edit-file-session'
  | 'allow-edit-folder-session'
  | 'docker-allow-once'
  | 'docker-allow-session'
  | 'docker-allow-project';
export type WireQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
};
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
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly presentation?: { readonly [key: string]: JsonValue };
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
export type WireToolResult = {
  readonly executionId: string;
  /** Original accepted call metadata, available even when reconnect starts after the call frame. */
  readonly toolName?: string;
  readonly input?: JsonValue;
  readonly callId?: string;
  readonly parentExecutionId?: string;
  readonly output: string;
  readonly isError: boolean;
  readonly display?: JsonValue;
  readonly content?: readonly WireContent[];
};
export type WireOrigin =
  | { readonly kind: 'cli' | 'acp' | 'api'; readonly id?: string }
  | { readonly kind: 'tui'; readonly id?: string; readonly skill?: { readonly name: string; readonly request: string } }
  | { readonly kind: 'control'; readonly id?: string; readonly source?: 'orchestrator' }
  | {
      readonly kind: 'discord';
      readonly source: 'human' | 'agent' | 'reaction';
      readonly sender: string;
      readonly discordMessageId?: string;
      readonly relayedBy?: string;
    };
export type WireAdmission =
  | {
      readonly kind: 'started' | 'queued' | 'steering';
      readonly clientRequestId: string;
      readonly messageId: string;
      readonly turnId?: string;
    }
  | {
      readonly kind: 'duplicate';
      readonly clientRequestId: string;
      readonly original: Exclude<WireAdmission, { readonly kind: 'duplicate' }>;
    }
  | { readonly kind: 'rejected'; readonly clientRequestId: string; readonly reason: string };
export type WireQueueEntry = {
  readonly messageId: string;
  readonly text: string;
  readonly delivery: 'queued' | 'steering';
  readonly clientRequestId: string;
  readonly content?: readonly WireContent[];
  readonly origin?: WireOrigin;
  readonly receivedAt?: string;
  readonly turnId?: string;
};
export type WireSubmissionRecord = {
  readonly clientRequestId: string;
  readonly messageId: string;
  readonly delivery: 'steer' | 'follow_up' | 'reject_if_busy';
  readonly origin?: WireOrigin;
  readonly receivedAt?: string;
  readonly originalContent: readonly WireContent[];
  readonly content: readonly WireContent[];
  readonly admission: WireAdmission;
  readonly stage:
    | 'queued'
    | 'pending_steer'
    | 'running'
    | 'steered'
    | 'finished'
    | 'retracted'
    | 'discarded'
    | 'cancelled';
  readonly turnId?: string;
  readonly outcome?: 'completed' | 'cancelled' | 'failed' | 'interrupted';
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
  | {
      readonly type: 'queue_cancelling';
      readonly turnId: string;
      readonly cancelledMessageIds: readonly string[];
      readonly retainedMessageIds: readonly string[];
      readonly preservePendingSteers?: boolean;
    }
  | {
      readonly type: 'queue_settled';
      readonly turnId: string;
      readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted';
      readonly preservePendingSteers?: boolean;
    }
  | { readonly type: 'queue_resumed' }
  | { readonly type: 'queue_recovered' };
/** Exact accepted public terminal evidence from the root audit; no provider history or private items. */
export type WireFinalWindow = DirectFinalWindow;
export type WireTerminal = {
  readonly finalText?: string | null;
  readonly outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly error?: WireError;
  readonly terminalCause?: string;
  readonly notice?: string;
  readonly finalWindow?: WireFinalWindow;
};
/** Public budget evidence, copied from accepted native observations, not a cost quote. */
export type WireAnswerProvenance = {
  readonly source: 'user' | 'policy' | 'system';
  readonly automaticApproval?: boolean;
};
export type WireBudgetEvidence =
  | {
      readonly type: 'budget_stage';
      readonly stage: 'soft' | 'warning' | 'critical';
      readonly evidence: {
        readonly dimension: 'usd' | 'unpriced_tokens' | 'active_time' | 'turns';
        readonly used: number;
        readonly limit: number;
        readonly headroom: number;
      };
    }
  | {
      readonly type: 'tool_stall';
      readonly toolName: string;
      readonly argumentsText: string;
      readonly count: number;
      readonly threshold: number;
    };
export type WireBudgetSnapshot = {
  readonly pricedUsdMicros: number;
  readonly unpricedTokens: number;
  readonly activeTimeMs: number;
  readonly turns: number;
  readonly extensionsGranted: number;
  readonly latchedStages: readonly ('soft' | 'warning' | 'critical')[];
};
export type WireBudgetRequest = {
  readonly requestId: string;
  readonly turnId: string;
  readonly evidence: WireBudgetEvidence;
  readonly snapshot: WireBudgetSnapshot;
};
export type WireBudgetDecision =
  | { readonly kind: 'extend'; readonly grantedBy: 'human' | 'parent' }
  | { readonly kind: 'stop' }
  | {
      readonly kind: 'steer';
      readonly items: readonly {
        readonly type: 'user_message';
        readonly id: string;
        readonly content: readonly WireContent[];
      }[];
    };
export type WireBudgetResolution =
  | Exclude<WireBudgetDecision, { readonly kind: 'steer' }>
  | { readonly kind: 'steer'; readonly messages: readonly WireMessage[] };
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
  readonly pendingQuestion?: { readonly messageId: string; readonly question: string };
  readonly status:
    | 'running'
    | 'awaiting_interaction'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly completedAt?: number;
  readonly text?: string;
  readonly progress?: string;
  readonly result?: WireTaskResult;
};
/** Public task descriptor ownership; does not imply the parent foreground still runs. */
export type WireTaskOwner = Pick<
  WireTask,
  'id' | 'turnId' | 'sessionId' | 'parentExecutionId' | 'sourceCallId' | 'origin' | 'kind' | 'name' | 'role'
>;
export type WireRetry = { readonly turn: boolean; readonly tool: boolean };
export type WireError = {
  readonly kind: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
};
export type WireNotice = { readonly kind: string; readonly message: string };
export type WireGoal = {
  readonly id: string;
  readonly text: string;
  readonly successCriteria?: string;
  readonly status: 'active' | 'blocked' | 'completed' | 'cancelled' | 'achieved' | 'abandoned';
};
export type WireVerification = {
  readonly status: 'pending' | 'running' | 'passed' | 'blocked' | 'failed';
  readonly message?: string;
  readonly attemptId?: string;
  readonly goalGeneration?: number;
  readonly revision?: string;
  readonly report?: {
    readonly outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR' | 'TIMEOUT';
    readonly evidence: string;
    readonly checked: readonly string[];
    readonly limitations: readonly string[];
    readonly verifierVersion: string;
  };
};
export type WireConfiguration = {
  readonly model?: WireModel;
  readonly reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly temperature?: number;
};
/** Requested configure selection only. Accepted output uses WireConfiguration. */
export type WireConfigureRequest = {
  readonly model?: WireModel;
  readonly reasoning?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly temperature?: number;
  readonly profileId?: string;
};
/** Native context estimates; these are not measured provider usage. */
export type WireCompactionEstimate = {
  readonly renderedInputTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly hardFitTokens: number;
};
/** Physical request evidence for an attempted compaction; not an extra charge. */
export type WireCompactionRequest = {
  readonly requestId: string;
  readonly modelStep: number;
  readonly model: WireModel;
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly usage?: WireUsage;
  readonly costUsd?: number | string;
};
export type WireCompactionBlockedReason =
  | 'disabled'
  | 'unknown_threshold'
  | 'native_unavailable'
  | 'unsettled_tools'
  | 'no_complete_cold_turn'
  | 'single_turn_too_large'
  | 'opaque_context'
  | 'summary_input_too_large'
  | 'non_reducing'
  | 'result_still_too_large';
export type WireCompactionFailure =
  | { readonly kind: 'blocked'; readonly reason: WireCompactionBlockedReason }
  | { readonly kind: 'interrupted'; readonly reason: 'budget_wrap_up' | 'budget_exhausted' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: WireError };
export type WireCompactionStarted = {
  readonly compactionId: string;
  readonly trigger: 'manual' | 'automatic';
  readonly model: WireModel;
  readonly before: WireCompactionEstimate;
  readonly strategy?: 'native' | 'local';
  readonly contextWindow?: number;
  readonly maxRequestInputTokens?: number | null;
  readonly lastCompletedInputTokens?: number;
};
export type WireCompactionCompleted = {
  readonly compactionId: string;
  readonly strategy: 'native' | 'local';
  readonly after: WireCompactionEstimate;
  readonly durationMs: number;
  readonly requests: readonly WireCompactionRequest[];
};
export type WireCompactionFailed = {
  readonly compactionId: string;
  readonly failure: WireCompactionFailure;
  readonly durationMs: number;
  readonly requests: readonly WireCompactionRequest[];
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
export type WireNativeCommandRequest = {
  readonly commandId: string;
  readonly operation: WireNativeCommandOperation;
} & WireCommandPreconditions;
export type WireNativeCommandOutcome =
  | { readonly kind: 'retried'; readonly turnId: string }
  | { readonly kind: 'rewound'; readonly draft: { readonly content: readonly WireContent[] } }
  | { readonly kind: 'compacted' }
  | { readonly kind: 'configured'; readonly configuration: WireConfiguration & { readonly model: WireModel } }
  | { readonly kind: 'rolled_over'; readonly sessionId: string }
  | {
      readonly kind: 'rejected';
      readonly code: 'ineligible' | 'stale' | 'busy' | 'unavailable' | 'cancelled' | 'failed';
      readonly message: string;
    }
  | { readonly kind: 'interrupted'; readonly reason: 'outcome_unobserved' };
export type WireCommandReceipt = {
  readonly request: WireNativeCommandRequest;
  readonly revision: string;
  readonly outcome?: WireNativeCommandOutcome;
};
/** Accepted Session planning notices; deliveries identify actual silent turns. */
export type WireBackgroundNotice = {
  readonly id: string;
  readonly kind: 'completion' | 'control' | 'check_in' | 'question';
  readonly taskIds: readonly string[];
  readonly text: string;
};
export type WireNoticeDelivery = {
  readonly clientRequestId: string;
  readonly turnId: string;
  readonly notificationIds: readonly string[];
};
export type WireNotifications = {
  readonly notices: readonly WireBackgroundNotice[];
  readonly deliveries: readonly WireNoticeDelivery[];
};
export type WireNotificationDrainResult =
  | { readonly kind: 'started' | 'duplicate'; readonly turnId: string; readonly notificationIds: readonly string[] }
  | { readonly kind: 'empty' | 'busy' }
  | { readonly kind: 'not_admitting'; readonly reason: string };
