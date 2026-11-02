/** Pure pinned agent-wire encoding of accepted direct events. No cursor, timestamp, terminal text
 * or tool identity is synthesized here. The caller supplies only authoritative replay-cut context
 * when a direct payload does not itself carry the immutable data needed by the pinned DTO.
 */
import type { AgentEventEnvelope } from '@qduc/agent-wire';
import type { WireAdmission, WireEvent } from '../protocol/direct-wire.js';
import { legacyCommandMessages } from '../protocol/direct-json.js';
import type { ServerInteractions } from './server-interactions.js';
import { taskCandidate, taskIdentity } from './server-task-events.js';
import {
  requiredTurn,
  text,
  errorReason,
  missing,
  type CanonicalEventCandidate,
  type CanonicalEventContext,
} from './server-event-values.js';
export type { CanonicalEventCandidate, CanonicalEventContext } from './server-event-values.js';

type Candidate = CanonicalEventCandidate;

/** Returns at most one numeric-ID envelope per accepted boundary. Non-public projection updates
 * return null. Missing accepted evidence or unsupported consumer semantics throws
 * instead of silently omitting a lifecycle boundary or lying to a retained BFF.
 */
export function encodeCanonicalEvent(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext = {},
): AgentEventEnvelope | null {
  const candidate = canonicalCandidate(event, interactions, context);
  if (!candidate) return null;
  if (event.seq === null || !Number.isSafeInteger(event.seq) || event.seq < 1)
    return missing('canonical events require an accepted durable cursor');
  if (!event.occurredAt || /[\u0000-\u001f\u007f]/u.test(event.occurredAt))
    return missing('canonical events require the original accepted timestamp');
  return {
    schemaVersion: 1,
    id: event.seq,
    sessionId: event.sessionId,
    type: candidate.type,
    occurredAt: event.occurredAt,
    payload: candidate.payload,
  };
}

export function canonicalCandidate(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): Candidate | null {
  switch (event.type) {
    case 'session_rotated':
      // The logical Session is unchanged, and pinned agent-wire has no rotation/reset event.
      // Direct SSE retains the actual accepted boundary; do not invent session_created or a
      // turn terminal. Canonical SSE stays gated: omitting a reset is not pinned reset parity.
      return null;
    case 'admission':
      return admissionCandidate(event.payload.admission);
    case 'queue_changed':
      return queueCandidate(event);
    case 'turn_started':
      return event.payload.foreground ? { type: 'assistant_started', payload: { turnId: requiredTurn(event) } } : null;
    case 'text_delta':
    case 'reasoning_delta':
      return { type: event.type, payload: { turnId: requiredTurn(event), delta: text(event.payload.delta) } };
    case 'tool_started':
      return {
        type: 'tool_started',
        payload: {
          turnId: requiredTurn(event),
          callId: event.payload.tool.executionId,
          toolName: text(event.payload.tool.toolName, 256),
        },
      };
    case 'tool_finished': {
      const messages = legacyCommandMessages(event);
      if (messages.length > 1)
        return missing('canonical command messages require separate accepted boundaries, not shared numeric IDs');
      if (messages.length === 1) return commandMessageCandidate(event, messages[0]!.message);
      const toolName = event.payload.toolName;
      if (toolName === undefined) return missing('canonical tool results require their accepted execution metadata');
      return {
        type: 'command_message',
        payload: {
          turnId: requiredTurn(event),
          callId: event.payload.executionId,
          toolName: text(toolName, 256),
          status: event.payload.isError ? 'failed' : 'completed',
          ...(event.payload.isError
            ? { error: text(event.payload.output, 10_000) }
            : { output: text(event.payload.output, 16_384) }),
        },
      };
    }
    case 'interaction_opened': {
      // Task-scoped interactions need the true nested owner/role, not a root relabeling.
      const taskId = event.payload.interaction.taskId ?? event.payload.interaction.taskOwner?.id;
      if (taskId) {
        return {
          type: 'subagent_approval_required',
          payload: {
            ...taskIdentity(taskId, context, undefined, event.payload.interaction.taskOwner),
            childTurnId: event.payload.interaction.turnId,
            interaction: interactions.project(event.sessionId, event.payload.interaction),
          },
        };
      }
      return {
        type: 'approval_required',
        payload: {
          turnId: requiredTurn(event),
          interaction: interactions.project(event.sessionId, event.payload.interaction),
        },
      };
    }
    case 'interaction_resolved': {
      const resolution = event.payload.resolution;
      const taskId = event.payload.taskId ?? event.payload.taskOwner?.id;
      return {
        type: 'interaction_resolved',
        payload: {
          turnId: requiredTurn(event),
          interactionId: event.payload.requestId,
          // Task closures already carry the parent turnId. Do not relabel it as a child turn.
          ...(taskId ? taskIdentity(taskId, context, undefined, event.payload.taskOwner) : {}),
          outcome:
            resolution.kind === 'cancelled' || resolution.kind === 'interrupted'
              ? 'cancelled'
              : resolution.kind === 'deny' || resolution.kind === 'decline'
              ? 'rejected'
              : 'approved',
        },
      };
    }
    case 'usage': {
      const { inputTokens, outputTokens } = event.payload.usage;
      const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
      return { type: 'usage_update', payload: { turnId: requiredTurn(event), ...usage, usage } };
    }
    case 'retrying':
      return {
        type: 'retry',
        payload: {
          turnId: requiredTurn(event),
          ...(event.payload.agentId ? { agentId: text(event.payload.agentId, 256) } : {}),
          ...(event.payload.toolName ? { toolName: text(event.payload.toolName, 256) } : {}),
          attempt: event.payload.attempt,
          ...(event.payload.maxRetries !== undefined ? { maxRetries: event.payload.maxRetries } : {}),
          errorMessage: text(event.payload.error.message),
          errorKind: event.payload.error.kind,
          delayMs: event.payload.delayMs,
          ...(event.payload.retryType ? { retryType: event.payload.retryType } : {}),
          ...(event.payload.retryAfterMs !== undefined ? { retryAfterMs: event.payload.retryAfterMs } : {}),
        },
      };
    case 'turn_ended': {
      const terminal = event.payload;
      const finalText = terminal.finalText;
      const identity = { turnId: requiredTurn(event) };
      const cause = {
        ...(terminal.terminalCause !== undefined ? { terminalCause: text(terminal.terminalCause, 128) } : {}),
        ...(terminal.notice !== undefined ? { notice: text(terminal.notice) } : {}),
      };
      if (terminal.outcome === 'completed') {
        if (finalText == null) return missing('canonical completion requires Session-correlated terminal text');
        return {
          type: 'turn_completed',
          payload: { ...identity, outcome: 'completed', text: text(finalText, 16_384), ...cause },
        };
      }
      if (terminal.outcome === 'cancelled')
        return { type: 'turn_aborted', payload: { ...identity, outcome: 'aborted', ...cause } };
      return {
        type: 'turn_failed',
        payload: {
          ...identity,
          outcome: 'failed',
          reason: terminal.outcome === 'interrupted' ? 'interrupted' : errorReason(terminal.error?.kind),
          ...(finalText != null ? { finalText: text(finalText, 16_384) } : {}),
          ...cause,
        },
      };
    }
    case 'budget_opened':
      return {
        type: 'approval_required',
        payload: { turnId: requiredTurn(event), interaction: interactions.projectBudget(event.payload.request) },
      };
    case 'budget_closed':
      return {
        type: 'interaction_resolved',
        payload: {
          turnId: requiredTurn(event),
          interactionId: event.payload.requestId,
          outcome: event.payload.decision.kind === 'stop' ? 'rejected' : 'approved',
        },
      };
    case 'budget_observed':
    case 'history_replaced':
    case 'model_response_completed':
    case 'request_cost_recorded':
    case 'command_started':
    case 'command_finished':
    case 'background_notice_enqueued':
    case 'background_notices_delivered':
    case 'tool_call_streaming_delta':
    case 'automatic_memory_notice':
      // Live argument counts are not tool execution, accepted argument text or a numeric-ID event.
      // The pinned event vocabulary has no automatic-memory notice envelope.
      return null;
    case 'subagent':
      return nestedCandidate(event, interactions, context);
    case 'task_changed':
      return taskCandidate(event, context);
    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed':
      // Real lifecycle evidence is present, but the frozen consumer cannot carry
      // its attempt/estimate/request/failure semantics faithfully. In particular,
      // do not guess a terminal provider, relabel estimates as measured tokens or
      // coerce blocked/interrupted/cancelled into a pinned errorCategory.
      return missing('canonical compaction lifecycle requires a versioned consumer contract; use direct event format');
    case 'compacted':
      // This presentation notice is neither an attempt start nor its outcome.
      return missing('the compacted notice cannot substitute for a canonical compaction lifecycle boundary');
    // These change the public read model but have no equivalent pinned root event. In particular,
    // a message is not a terminal, and a cumulative reasoning summary is not a reasoning delta.
    case 'snapshot':
    case 'message':
    case 'reasoning':
    case 'tool_called':
    case 'tool_progress':
    case 'status_changed':
    case 'retry_eligibility':
    case 'configuration':
    case 'task_progress':
    case 'cost':
    case 'notice':
    case 'goal':
    case 'goal_proposed':
    case 'verification':
    case 'error':
      return null;
  }
}
/** Child publication keeps the outer accepted boundary and the real parent/child identities.
 * A child turn terminal is not task settlement: only the Session's task_finished fact owns that.
 * Completed child messages are text turns; partial chunks are not mislabeled as completed replies.
 */
function nestedCandidate(
  event: Extract<WireEvent, { type: 'subagent' }>,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): Candidate | null {
  const { event: child, agentId } = event.payload;
  switch (child.type) {
    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed':
      // Preserve the branch wrapper in direct transport. Never promote the child
      // to root or replace its null cursor with a made-up pinned boundary.
      return missing(
        'canonical branch compaction lifecycle requires a versioned consumer contract; use direct event format',
      );
    case 'tool_call_streaming_delta':
    case 'background_notice_enqueued':
    case 'background_notices_delivered':
      return null;
  }
  // Current wire carries the actual parent separately. Older payloads may use accepted cut
  // context, but neither a child turnId nor rootTurnId is a substitute for the immediate parent.
  const task = context.task?.id === agentId ? context.task : undefined;
  const parentTurnId = event.payload.parentTurnId ?? task?.turnId;
  const role = event.payload.role ?? task?.role;
  if (!parentTurnId || !role) return missing('canonical child events require their accepted parent and role');
  const identity = {
    turnId: parentTurnId,
    agentId: text(agentId, 256),
    role: text(role, 256),
    ...(event.payload.rootTurnId ? { rootTurnId: event.payload.rootTurnId } : {}),
    ...(child.turnId !== null ? { childTurnId: child.turnId } : {}),
    ...(event.payload.branchId ? { branchId: event.payload.branchId } : {}),
  };
  switch (child.type) {
    case 'tool_started':
      return {
        type: 'subagent_tool_started',
        payload: {
          ...identity,
          toolCallId: child.payload.tool.executionId,
          toolName: text(child.payload.tool.toolName, 256),
        },
      };
    case 'tool_finished': {
      const candidate = canonicalCandidate(child, interactions, context);
      if (!candidate) return null;
      return { type: 'subagent_command_message', payload: { ...candidate.payload, ...identity } };
    }
    case 'message':
      return child.payload.message.role === 'assistant' && !child.payload.message.draft
        ? { type: 'subagent_text_turn', payload: { ...identity, text: text(child.payload.message.text, 16_384) } }
        : null;
    case 'interaction_opened':
      return {
        type: 'subagent_approval_required',
        payload: { ...identity, interaction: interactions.project(event.sessionId, child.payload.interaction) },
      };
    case 'budget_opened':
      return {
        type: 'subagent_approval_required',
        payload: { ...identity, interaction: interactions.projectBudget(child.payload.request) },
      };
    case 'interaction_resolved':
    case 'budget_closed':
      return {
        type: 'interaction_resolved',
        payload: {
          ...identity,
          interactionId: child.payload.requestId,
          outcome:
            child.type === 'budget_closed'
              ? child.payload.decision.kind === 'stop'
                ? 'rejected'
                : 'approved'
              : child.payload.resolution.kind === 'cancelled' || child.payload.resolution.kind === 'interrupted'
              ? 'cancelled'
              : child.payload.resolution.kind === 'deny' || child.payload.resolution.kind === 'decline'
              ? 'rejected'
              : 'approved',
        },
      };
    case 'retrying': {
      const candidate = canonicalCandidate(child, interactions, context);
      return candidate ? { ...candidate, payload: { ...candidate.payload, ...identity } } : null;
    }
    case 'turn_started':
    case 'turn_ended':
    case 'text_delta':
    case 'reasoning':
    case 'reasoning_delta':
    case 'tool_called':
    case 'tool_progress':
    case 'usage':
    case 'budget_observed':
    case 'history_replaced':
    case 'model_response_completed':
    case 'request_cost_recorded':
    case 'command_started':
    case 'command_finished':
    case 'automatic_memory_notice':
    case 'snapshot':
    case 'status_changed':
    case 'retry_eligibility':
    case 'configuration':
    case 'task_progress':
    case 'cost':
    case 'notice':
    case 'goal':
    case 'goal_proposed':
    case 'verification':
    case 'error':
      // Task acceptance/settlement own subagent_started/completed, not a child root turn boundary.
      return null;
    default:
      return missing('canonical child lifecycle requires its accepted task-owned projection');
  }
}
/** Preserve one accepted queue boundary. Aggregate native discard/cancel IDs cannot become
 * several distinct numeric-ID rejection frames without real pinned aggregate consumer support.
 */
function queueCandidate(event: Extract<WireEvent, { type: 'queue_changed' }>): Candidate | null {
  const { change } = event.payload;
  switch (change.type) {
    case 'queue_submitted':
      return admissionCandidate(change.record.admission);
    case 'queue_retracted':
      return missing('canonical queue retraction requires a supported pinned rejection policy');
    case 'queue_discarded':
      return change.messageIds.length
        ? missing('canonical aggregate queue discard requires a supported pinned rejection policy')
        : null;
    case 'queue_cancelling':
      return change.cancelledMessageIds.length
        ? missing('canonical aggregate queue cancellation requires a supported pinned rejection policy')
        : null;
    case 'queue_edited':
    case 'queue_started':
    case 'queue_steered':
    case 'queue_settled':
    case 'queue_resumed':
    case 'queue_recovered':
      // Root starts/terminals come from their actual separate accepted facts, not queue state.
      return null;
  }
}
function admissionCandidate(admission: WireAdmission): Candidate | null {
  if (admission.kind === 'duplicate') return null; // A read/retry is not a second admission event.
  if (admission.kind === 'rejected')
    return {
      type: 'user_message_rejected',
      payload: { clientRequestId: admission.clientRequestId, reason: text(admission.reason, 256) },
    };
  if (!admission.turnId) return missing('canonical admission requires its reserved turn identity');
  return {
    type: 'user_message_accepted',
    payload: {
      turnId: admission.turnId,
      clientRequestId: admission.clientRequestId,
      messageId: admission.messageId,
    },
  };
}
/** One accepted command display message; multiple messages stay in the same accepted boundary. */
function commandMessageCandidate(
  event: Extract<WireEvent, { type: 'tool_finished' }>,
  message: ReturnType<typeof legacyCommandMessages>[number]['message'],
): Candidate {
  const callId = message.callId ?? event.payload.callId;
  const toolName = message.toolName ?? event.payload.toolName;
  if (!callId || !toolName) return missing('canonical command display requires its accepted call identity');
  return {
    type: 'command_message',
    payload: {
      turnId: requiredTurn(event),
      callId: text(callId, 256),
      toolName: text(toolName, 256),
      status: message.status,
      output: text(message.output, 16_384),
      ...(message.failureReason !== undefined ? { error: text(message.failureReason, 10_000) } : {}),
      message: { id: text(message.id, 256), role: 'command', text: text(message.command, 16_384) },
    },
  };
}
/** V2 may publish every real command display in one accepted batch; v1 remains one-per-envelope. */
export function canonicalCommandMessageCandidates(
  event: Extract<WireEvent, { type: 'tool_finished' }>,
): CanonicalEventCandidate[] {
  return legacyCommandMessages(event).map(({ message }) => commandMessageCandidate(event, message));
}
