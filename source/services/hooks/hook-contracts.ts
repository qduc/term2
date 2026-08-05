/** The schema version of the public Term2 hook event contract. */
export const TERM2_HOOK_SCHEMA_VERSION = 1 as const;

export type Term2HookSchemaVersion = typeof TERM2_HOOK_SCHEMA_VERSION;

export const TERM2_HOOK_EVENT_NAMES = [
  'session.start',
  'session.end',
  'status.change',
  'turn.start',
  'turn.end',
  'turn.error',
  'tool.before',
  'tool.after',
  'tool.error',
  'approval.requested',
  'approval.resolved',
] as const;

export type Term2HookEventName = (typeof TERM2_HOOK_EVENT_NAMES)[number];

export type Term2HookScope = 'root' | { readonly subagent: Term2SubagentScope };

export interface Term2SubagentScope {
  readonly agentId: string;
  readonly role: string;
}

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

export function isTerm2HookEventName(value: unknown): value is Term2HookEventName {
  return typeof value === 'string' && (TERM2_HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

export function isTerm2HookScope(value: unknown): value is Term2HookScope {
  if (value === 'root') return true;
  if (typeof value !== 'object' || value === null) return false;
  const subagent = (value as { subagent?: unknown }).subagent;
  return (
    typeof subagent === 'object' &&
    subagent !== null &&
    typeof (subagent as { agentId?: unknown }).agentId === 'string' &&
    typeof (subagent as { role?: unknown }).role === 'string'
  );
}

export function isTerm2HookEvent(value: unknown): value is Term2HookEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<HookEventBase>;
  const hasString = (key: string): boolean => typeof (value as Record<string, unknown>)[key] === 'string';
  const hasFiniteNumber = (key: string): boolean => {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'number' && Number.isFinite(candidate);
  };
  const hasBoolean = (key: string): boolean => typeof (value as Record<string, unknown>)[key] === 'boolean';
  const oneOf = (key: string, candidates: readonly string[]): boolean => {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' && candidates.includes(candidate);
  };

  if (
    !(
      isTerm2HookEventName(event.type) &&
      event.schemaVersion === TERM2_HOOK_SCHEMA_VERSION &&
      hasString('eventId') &&
      hasString('sessionId') &&
      hasFiniteNumber('timestamp') &&
      isTerm2HookScope(event.scope)
    )
  )
    return false;

  switch (event.type) {
    case 'session.start':
      return (
        hasString('cwd') &&
        oneOf('mode', ['interactive', 'non-interactive']) &&
        hasString('providerName') &&
        hasString('modelName')
      );
    case 'session.end':
      return oneOf('reason', ['normal', 'fatal_error']) && hasFiniteNumber('sessionDuration');
    case 'status.change':
      return (
        oneOf('previous', ['idle', 'working', 'waiting_for_user', 'waiting_for_approval']) &&
        oneOf('current', ['idle', 'working', 'waiting_for_user', 'waiting_for_approval']) &&
        hasString('reason')
      );
    case 'turn.start':
      return oneOf('origin', ['user', 'queued', 'approval_continuation']);
    case 'turn.end':
      return oneOf('terminalKind', ['response', 'approval_required', 'stale', 'failed']) && hasFiniteNumber('duration');
    case 'turn.error':
      return hasString('errorCategory') && hasString('safeMessage') && hasBoolean('recoverable');
    case 'tool.before':
      return (
        hasString('toolName') &&
        hasFiniteNumber('attempt') &&
        isTerm2HookScope((value as { ownership?: unknown }).ownership)
      );
    case 'tool.after':
      return hasString('toolName') && hasFiniteNumber('duration');
    case 'tool.error':
      return (
        hasString('toolName') &&
        hasFiniteNumber('duration') &&
        hasString('errorCategory') &&
        hasString('safeMessage') &&
        hasBoolean('convertedToModelResult')
      );
    case 'approval.requested':
      return (
        hasString('toolName') &&
        oneOf('approvalKind', ['tool', 'ask_user', 'preflight', 'other']) &&
        oneOf('proposedDecision', ['approve', 'reject', 'abort', 'auto_approve'])
      );
    case 'approval.resolved':
      return (
        oneOf('resolution', ['approved', 'rejected', 'aborted', 'auto_approved']) &&
        oneOf('source', ['user', 'policy', 'system']) &&
        hasBoolean('executionFollowed')
      );
  }

  return false;
}
