import { isTruncatedLogEvent, type LogEnvelope, type PersistedLogEvent } from '../logging/conversation-log-events.js';

/**
 * How a persisted session's last turn ended.
 *
 * The distinction that matters for an unattended run is `awaiting_approval`
 * versus `interrupted_mid_tool`: the first means the agent stopped and waited
 * for a human who never came, the second means the process died with work
 * dispatched. Both look like "nothing happened for six hours" from the outside
 * and have opposite remedies.
 */
export type SessionOutcome =
  | 'empty'
  | 'settled'
  | 'awaiting_approval'
  | 'interrupted_mid_tool'
  | 'interrupted_mid_turn';

export interface UnfinishedToolCall {
  readonly callId: string;
  readonly toolName: string;
}

export interface UnfinishedSubagent {
  readonly agentId: string;
  readonly role: string;
}

export interface UnfinishedBackgroundShell {
  readonly jobId: string;
  readonly command: string;
}

export interface SessionAuditToolCounts {
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  /**
   * Dispatched but never observed. Counted separately because it is not a
   * success and not a failure: nothing here proves whether the effect landed.
   */
  readonly unknown: number;
}

export interface SessionAudit {
  readonly sessionId?: string;
  readonly outcome: SessionOutcome;
  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly toolCalls: SessionAuditToolCounts;
  readonly unfinishedToolCalls: readonly UnfinishedToolCall[];
  readonly unfinishedSubagents: readonly UnfinishedSubagent[];
  readonly unfinishedBackgroundShells: readonly UnfinishedBackgroundShell[];
  readonly errors: readonly { readonly message: string; readonly kind?: string }[];
  /** Storage-side truncation markers, i.e. evidence the log itself is lossy. */
  readonly truncatedEvents: number;
  readonly firstEventAt?: string;
  readonly lastEventAt?: string;
}

/**
 * Derive an after-the-fact verdict about one persisted session from its event
 * log alone, without resuming it.
 *
 * The in-flight bookkeeping here deliberately mirrors `replayEvents`: a call is
 * registered by `tool_started` (and by `approval_required`, which can name a
 * call the process died before dispatching), retired by `tool_result`, and
 * cleared wholesale by `assistant_turn` and `undo`. That correspondence is the
 * point — the audit reports what a resume of the same log would find, so the
 * two cannot disagree about whether work was left unpaid.
 *
 * `session_cleared` is intentionally not treated as a reset, matching replay,
 * which also ignores it here.
 */
export function auditSessionLog(envelopes: readonly LogEnvelope<PersistedLogEvent>[]): SessionAudit {
  const inFlight = new Map<string, UnfinishedToolCall>();
  const openSubagents = new Map<string, UnfinishedSubagent>();
  const openShells = new Map<string, UnfinishedBackgroundShell>();
  const errors: { message: string; kind?: string }[] = [];

  let sessionId: string | undefined;
  let userTurns = 0;
  let assistantTurns = 0;
  let truncatedEvents = 0;
  let trailingUserMessage = false;
  let pendingApproval: UnfinishedToolCall | undefined;

  let started = 0;
  let completed = 0;
  let failed = 0;
  let aborted = 0;
  let unknown = 0;

  for (const envelope of envelopes) {
    const event = envelope.event;
    if (isTruncatedLogEvent(event)) {
      truncatedEvents++;
      continue;
    }

    switch (event.type) {
      case 'session_init':
        sessionId = event.id;
        break;
      case 'user_message':
        userTurns++;
        trailingUserMessage = true;
        break;
      case 'assistant_turn':
        assistantTurns++;
        trailingUserMessage = false;
        inFlight.clear();
        pendingApproval = undefined;
        break;
      case 'undo':
        trailingUserMessage = false;
        inFlight.clear();
        pendingApproval = undefined;
        break;
      case 'tool_started':
        started++;
        inFlight.set(event.toolCallId, { callId: event.toolCallId, toolName: event.toolName });
        break;
      case 'tool_result':
        inFlight.delete(event.callId);
        if (event.status === 'completed') completed++;
        else if (event.status === 'failed') failed++;
        else if (event.status === 'aborted') aborted++;
        else unknown++;
        break;
      case 'approval_required': {
        const callId = event.approval.callId;
        const pending = { callId: callId ?? '', toolName: event.approval.toolName };
        pendingApproval = pending;
        if (callId && !inFlight.has(callId)) {
          inFlight.set(callId, { callId, toolName: event.approval.toolName });
        }
        break;
      }
      case 'approval_resolved':
        pendingApproval = undefined;
        break;
      case 'subagent_started':
        openSubagents.set(event.agentId, { agentId: event.agentId, role: event.role });
        break;
      case 'subagent_completed':
        openSubagents.delete(event.result.agentId);
        break;
      case 'subagent_interrupted':
      case 'subagent_transferred':
        openSubagents.delete(event.agentId);
        break;
      case 'background_shell_started':
        openShells.set(event.jobId, { jobId: event.jobId, command: event.command });
        break;
      case 'background_shell_completed':
        openShells.delete(event.jobId);
        break;
      case 'error':
        errors.push(event.kind ? { message: event.message, kind: event.kind } : { message: event.message });
        break;
      default:
        break;
    }
  }

  const unfinishedToolCalls = [...inFlight.values()];
  const outcome: SessionOutcome =
    userTurns === 0
      ? 'empty'
      : pendingApproval
      ? 'awaiting_approval'
      : unfinishedToolCalls.length > 0
      ? 'interrupted_mid_tool'
      : trailingUserMessage
      ? 'interrupted_mid_turn'
      : 'settled';

  return {
    sessionId,
    outcome,
    userTurns,
    assistantTurns,
    toolCalls: { started, completed, failed, aborted, unknown },
    unfinishedToolCalls,
    unfinishedSubagents: [...openSubagents.values()],
    unfinishedBackgroundShells: [...openShells.values()],
    errors,
    truncatedEvents,
    firstEventAt: envelopes[0]?.ts,
    lastEventAt: envelopes[envelopes.length - 1]?.ts,
  };
}

const OUTCOME_SUMMARY: Record<SessionOutcome, string> = {
  empty: 'No user turns were recorded.',
  settled: 'Ended cleanly after a completed assistant turn.',
  awaiting_approval: 'Stopped waiting for an approval that was never answered.',
  interrupted_mid_tool: 'Ended with tool calls dispatched but never observed.',
  interrupted_mid_turn: 'Ended after a user turn that never produced a reply.',
};

/** Render an audit as plain text for a report or a terminal. */
export function formatSessionAudit(audit: SessionAudit): string {
  const lines: string[] = [];
  lines.push(`Session ${audit.sessionId ?? '(unknown)'}: ${audit.outcome}`);
  lines.push(OUTCOME_SUMMARY[audit.outcome]);
  lines.push(`Turns: ${audit.userTurns} user, ${audit.assistantTurns} assistant`);
  const t = audit.toolCalls;
  lines.push(
    `Tools: ${t.started} started, ${t.completed} completed, ${t.failed} failed, ${t.aborted} aborted, ${t.unknown} unknown`,
  );
  for (const call of audit.unfinishedToolCalls) {
    lines.push(`  unfinished tool: ${call.toolName} (${call.callId || 'no call id'})`);
  }
  for (const agent of audit.unfinishedSubagents) {
    lines.push(`  unfinished subagent: ${agent.role} (${agent.agentId})`);
  }
  for (const shell of audit.unfinishedBackgroundShells) {
    lines.push(`  unfinished background shell: ${shell.command} (${shell.jobId})`);
  }
  for (const error of audit.errors) {
    lines.push(`  error${error.kind ? ` [${error.kind}]` : ''}: ${error.message}`);
  }
  if (audit.truncatedEvents > 0) {
    lines.push(`  ${audit.truncatedEvents} truncated event(s): this log is lossy`);
  }
  return lines.join('\n');
}
