/** Pure pinned agent-wire encoding of accepted direct events. No cursor, timestamp, terminal text
 * or tool identity is synthesized here. The caller supplies only authoritative replay-cut context
 * when a direct payload does not itself carry the immutable data needed by the pinned DTO.
 */
import type { AgentEventEnvelope, AgentEventType } from '@qduc/agent-wire';
import type { WireAdmission, WireEvent, WireTask } from '../protocol/direct-wire.js';
import type { ServerInteractions } from './server-interactions.js';
import { ServerHttpError } from './server-errors.js';

export type CanonicalEventContext = {
  /** Accepted immutable task owner at the replay cut; never the latest unrelated task. */
  readonly task?: WireTask;
};
type Candidate = { type: AgentEventType; payload: Readonly<Record<string, unknown>> };

/** Returns at most one numeric-ID envelope per accepted boundary. Non-public projection updates
 * return null. Missing required accepted evidence throws instead of lying to a retained BFF.
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

function canonicalCandidate(
  event: WireEvent,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): Candidate | null {
  const turnId = event.turnId;
  switch (event.type) {
    case 'admission':
      return admissionCandidate(event.payload.admission);
    case 'queue_changed':
      return event.payload.admission ? admissionCandidate(event.payload.admission) : null;
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
      if (event.payload.interaction.taskId) {
        return {
          type: 'subagent_approval_required',
          payload: {
            ...taskIdentity(event.payload.interaction.taskId, context),
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
      return {
        type: 'interaction_resolved',
        payload: {
          turnId: requiredTurn(event),
          interactionId: event.payload.requestId,
          // Task closures already carry the parent turnId. Do not relabel it as a child turn.
          ...(event.payload.taskId ? taskIdentity(event.payload.taskId, context) : {}),
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
    // The pinned event vocabulary has no automatic-memory notice envelope.
    case 'automatic_memory_notice':
      return null;
    case 'subagent':
      return nestedCandidate(event, interactions, context);
    case 'task_changed':
      if (event.payload.task.kind === 'shell') return null;
      return missing('canonical task lifecycle requires accepted nested terminal and descriptor data');
    case 'compacted':
      return missing('canonical compaction requires accepted provider, strategy and timing evidence');
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
  const identity = {
    ...taskIdentity(agentId, context, event.payload.role),
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
    // Task acceptance/settlement own subagent_started/completed, not a child root turn boundary.
    case 'text_delta':
    case 'reasoning':
    case 'reasoning_delta':
    case 'tool_called':
    case 'tool_progress':
    case 'usage':
    case 'budget_observed':
    case 'history_replaced':
    case 'model_response_completed':
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
      return null;
    default:
      return missing('canonical child lifecycle requires its accepted task-owned projection');
  }
}
/** Accept only the task's original parent identity. A nested branch's outer turnId is its child,
 * and a task interaction closure's outer turnId is already its parent; neither can be copied blindly.
 */
function taskIdentity(taskId: string, context: CanonicalEventContext, role?: string) {
  const task = context.task;
  if (!task || task.id !== taskId || !task.turnId)
    return missing('canonical nested events require their accepted parent task identity');
  const acceptedRole = role ?? task.role;
  if (!acceptedRole) return missing('canonical nested events require their accepted role');
  return { turnId: task.turnId, agentId: text(task.id, 256), role: text(acceptedRole, 256) };
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
function requiredTurn(event: WireEvent): string {
  return event.turnId ?? missing('canonical turn event requires its accepted turn identity');
}
function text(value: string, max = 65_536): string {
  return value.slice(0, max).replace(/[\u0000\u007f]/gu, '\uFFFD');
}
function errorReason(kind: string | undefined): string {
  switch (kind) {
    case 'provider':
      return 'provider_error';
    case 'network':
      return 'network_error';
    case 'authentication':
      return 'authentication_error';
    case 'rate_limit':
      return 'rate_limit';
    case 'cancelled':
      return 'cancelled';
    case 'validation':
      return 'validation_error';
    case 'compaction':
      return 'compaction_failed';
    case 'retry_exhausted':
      return 'retry_exhausted';
    default:
      return 'runtime_error';
  }
}
function missing(message: string): never {
  throw new ServerHttpError(503, 'event_envelope_unavailable', message, true, { reloadRequired: true });
}
