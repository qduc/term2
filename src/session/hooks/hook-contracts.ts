import type { ToolExecutionScope, ToolExecutionSubagentScope } from '../../tools/types.js';

export type Term2HookSchemaVersion = 1;

export type Term2HookEventName =
  | 'session.start'
  | 'session.end'
  | 'status.change'
  | 'turn.start'
  | 'turn.end'
  | 'turn.error'
  | 'tool.before'
  | 'tool.after'
  | 'tool.error'
  | 'approval.requested'
  | 'approval.resolved';

export type Term2HookScope = ToolExecutionScope;

export type Term2SubagentScope = ToolExecutionSubagentScope;

/**
 * The fields shared by every public hook event.  IDs are opaque to hook
 * authors; in particular, they are not provider response IDs or queue IDs.
 */
export interface HookEventBase<Name extends Term2HookEventName = Term2HookEventName> {
  readonly type: Name;
  readonly schemaVersion: Term2HookSchemaVersion;
  readonly eventId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly scope: Term2HookScope;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

export type Term2HookEventBase<Name extends Term2HookEventName = Term2HookEventName> = HookEventBase<Name>;

export type Term2SessionMode = 'interactive' | 'non-interactive';

export interface SessionStartHookEvent extends HookEventBase<'session.start'> {
  readonly cwd: string;
  readonly mode: Term2SessionMode;
  readonly providerName: string;
  readonly modelName: string;
}

export type SessionEndReason = 'normal' | 'fatal_error';

export interface SessionEndHookEvent extends HookEventBase<'session.end'> {
  readonly reason: SessionEndReason;
  readonly sessionDuration: number;
}

export type Term2Status = 'idle' | 'working' | 'waiting_for_user' | 'waiting_for_approval';

/** Stable, coarse reasons for a public status transition. */
export type Term2StatusChangeReason =
  | 'startup'
  | 'user_turn'
  | 'queued_turn'
  | 'approval_continuation'
  | 'turn_started'
  | 'turn_finished'
  | 'turn_failed'
  | 'tool_started'
  | 'tool_finished'
  | 'approval_requested'
  | 'approval_resolved'
  | 'ask_user'
  | 'reset'
  | 'undo'
  | 'provider_changed'
  | 'tool_retry'
  | 'shutdown';

export interface StatusChangeHookEvent extends HookEventBase<'status.change'> {
  readonly previous: Term2Status;
  readonly current: Term2Status;
  readonly reason: Term2StatusChangeReason;
}

export type Term2TurnOrigin = 'user' | 'queued' | 'approval_continuation';

export interface TurnStartHookEvent extends HookEventBase<'turn.start'> {
  readonly origin: Term2TurnOrigin;
  /** Omitted unless the user has opted into sending user text to hooks. */
  readonly userText?: string;
}

export type Term2TurnTerminalKind = 'response' | 'approval_required' | 'stale' | 'failed';

export interface TurnEndHookEvent extends HookEventBase<'turn.end'> {
  readonly terminalKind: Term2TurnTerminalKind;
  readonly duration: number;
}

export type Term2ErrorCategory =
  | 'aborted'
  | 'approval_rejected'
  | 'authentication'
  | 'configuration'
  | 'network'
  | 'provider'
  | 'rate_limited'
  | 'tool'
  | 'unknown';

export interface TurnErrorHookEvent extends HookEventBase<'turn.error'> {
  readonly errorCategory: Term2ErrorCategory;
  readonly safeMessage: string;
  readonly recoverable: boolean;
}

/** Metadata describing which runtime owns a physical tool invocation. */
export type Term2ToolOwnership = Term2HookScope;

export interface ToolBeforeHookEvent extends HookEventBase<'tool.before'> {
  readonly toolName: string;
  /** Normalized, privacy-filtered arguments. */
  readonly normalizedArguments: unknown;
  readonly attempt: number;
  readonly ownership: Term2ToolOwnership;
}

export interface ToolAfterHookEvent extends HookEventBase<'tool.after'> {
  readonly toolName: string;
  readonly duration: number;
  /** A summary is used by default; full output is an opt-in setting. */
  readonly normalizedResultSummary: unknown;
}

export interface ToolErrorHookEvent extends HookEventBase<'tool.error'> {
  readonly toolName: string;
  readonly duration: number;
  readonly errorCategory: Term2ErrorCategory;
  readonly safeMessage: string;
  readonly convertedToModelResult: boolean;
}

export type Term2ApprovalKind = 'tool' | 'ask_user' | 'preflight' | 'other';
export type Term2ProposedDecision = 'approve' | 'reject' | 'abort' | 'auto_approve';

export interface ApprovalRequestedHookEvent extends HookEventBase<'approval.requested'> {
  readonly toolName: string;
  readonly normalizedArguments: unknown;
  readonly approvalKind: Term2ApprovalKind;
  readonly proposedDecision: Term2ProposedDecision;
}

export type Term2ApprovalResolution = 'approved' | 'rejected' | 'aborted' | 'auto_approved';
export type Term2ApprovalResolutionSource = 'user' | 'policy' | 'system';

export interface ApprovalResolvedHookEvent extends HookEventBase<'approval.resolved'> {
  readonly resolution: Term2ApprovalResolution;
  readonly source: Term2ApprovalResolutionSource;
  readonly executionFollowed: boolean;
}

export interface Term2HookEventMap {
  readonly 'session.start': SessionStartHookEvent;
  readonly 'session.end': SessionEndHookEvent;
  readonly 'status.change': StatusChangeHookEvent;
  readonly 'turn.start': TurnStartHookEvent;
  readonly 'turn.end': TurnEndHookEvent;
  readonly 'turn.error': TurnErrorHookEvent;
  readonly 'tool.before': ToolBeforeHookEvent;
  readonly 'tool.after': ToolAfterHookEvent;
  readonly 'tool.error': ToolErrorHookEvent;
  readonly 'approval.requested': ApprovalRequestedHookEvent;
  readonly 'approval.resolved': ApprovalResolvedHookEvent;
}

export type Term2HookEvent<Name extends Term2HookEventName = Term2HookEventName> = Term2HookEventMap[Name];

export type Term2HookCallback<Name extends Term2HookEventName> = (event: Term2HookEvent<Name>) => void | Promise<void>;

export interface Term2Hooks {
  on<Name extends Term2HookEventName>(event: Name, callback: Term2HookCallback<Name>): () => void;
}

export type Term2HookRegistration = (hooks: Term2Hooks) => void | Promise<void>;
