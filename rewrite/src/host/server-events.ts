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
        const task = context.task;
        if (!task || task.id !== event.payload.interaction.taskId || !task.turnId || !task.role)
          return missing('canonical nested interactions require their accepted owner metadata');
        return {
          type: 'subagent_approval_required',
          payload: {
            turnId: task.turnId,
            childTurnId: event.payload.interaction.turnId,
            agentId: task.id,
            role: text(task.role, 256),
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
      if (event.payload.taskId) return missing('canonical nested resolutions require their accepted owner metadata');
      const resolution = event.payload.resolution;
      return {
        type: 'interaction_resolved',
        payload: {
          turnId: requiredTurn(event),
          interactionId: event.payload.requestId,
          ...(task
            ? { turnId: task.turnId, agentId: task.id, role: text(task.role!, 256), childTurnId: event.turnId }
            : {}),
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
          ...(task
            ? { turnId: task.turnId, agentId: task.id, role: text(task.role!, 256), childTurnId: event.turnId }
            : {}),
          outcome: event.payload.decision.kind === 'stop' ? 'rejected' : 'approved',
        },
      };
    case 'budget_observed':
    case 'history_replaced':
    case 'model_response_completed':
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
 * Completed child messages are text turns; partial chunks are not mislabeled as completed replies.
 */
function nestedCandidate(
  event: Extract<WireEvent, { type: 'subagent' }>,
  interactions: ServerInteractions,
  context: CanonicalEventContext,
): Candidate | null {
  const { event: child, agentId } = event.payload;
  const task = context.task;
  if (!task || task.id !== agentId || !task.turnId)
    return missing('canonical child events require their accepted parent task identity');
  const role = event.payload.role ?? task.role;
  if (!role) return missing('canonical child events require their accepted role');
  const finalText = child.type === 'turn_ended' ? child.payload.finalText : undefined;
  const identity = {
    turnId: task.turnId,
    agentId: text(agentId, 256),
    role: text(role, 256),
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
    case 'turn_ended':
      if (finalText == null) return missing('canonical child completion requires its Session-correlated terminal text');
      return {
        type: child.payload.outcome === 'interrupted' ? 'subagent_interrupted' : 'subagent_completed',
        payload: {
          ...identity,
          status: child.payload.outcome,
          finalText: text(finalText, 16_384),
          ...(child.payload.terminalCause !== undefined
            ? { terminalCause: text(child.payload.terminalCause, 128) }
            : {}),
          ...(child.payload.error ? { error: text(child.payload.error.message) } : {}),
        },
      };
    case 'retrying': {
      const candidate = canonicalCandidate(child, interactions, context);
      return candidate ? { ...candidate, payload: { ...candidate.payload, ...identity } } : null;
    }
    case 'turn_started':
    // The authoritative task descriptor owns subagent_started; the child root is not a new task.
    case 'text_delta':
    case 'reasoning':
    case 'reasoning_delta':
    case 'tool_called':
    case 'tool_progress':
    case 'usage':
      return null;
    default:
      return missing('canonical child lifecycle requires its accepted task-owned projection');
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
