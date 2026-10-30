import type { Item } from '../model/index.js';
import type { LogEntry, SessionState, SessionUpdate } from '../session/index.js';
import { PROTOCOL_VERSION, type Projection, type WireEvent, type WireInteraction, type WireMessage } from './index.js';

const MAX_TEXT = 8_192;
const bounded = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

function toCompatibilityMessage(item: Item): WireMessage | null {
  switch (item.type) {
    case 'user_message':
    case 'assistant_message':
      return {
        id: item.id,
        role: item.type === 'user_message' ? 'user' : 'assistant',
        text: bounded(item.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('')),
      };
    case 'tool_result':
      return { id: item.id, role: 'tool', text: bounded(item.output), isError: item.isError };
    default:
      return null;
  }
}

function toSavedMessage(value: unknown): WireMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as { id?: unknown; sender?: unknown; text?: unknown };
  if (typeof message.id !== 'string' || typeof message.text !== 'string') return null;
  if (message.sender === 'user') return { id: message.id, role: 'user', text: bounded(message.text) };
  if (message.sender === 'bot') return { id: message.id, role: 'assistant', text: bounded(message.text) };
  return null;
}

function pendingAsLegacyWire(pending: NonNullable<SessionState['pendingInteraction']>): WireInteraction | null {
  const dto = pending.interaction;
  if (dto.kind !== 'tool_approval') return null;
  const label = dto.choices
    .map((choice) => choice.label)
    .filter(Boolean)
    .join(' / ');
  const summary = label || dto.descriptor.display?.warning || dto.descriptor.toolName;
  return {
    interactionId: dto.interactionId,
    approvals: [
      {
        callId: dto.descriptor.callId ?? dto.interactionId,
        toolName: dto.descriptor.toolName,
        summary: bounded(summary),
        risk: 'medium',
      },
    ],
  };
}

function factEvent(sessionId: string, entry: LogEntry): WireEvent | null {
  const base = { sessionId, seq: entry.seq };
  const fact = entry.fact;
  switch (fact.type) {
    case 'session_turn_started':
      return { ...base, turnId: fact.turnId, type: 'turn_started', payload: {} };
    case 'session_interaction_pending': {
      const pending = pendingAsLegacyWire({
        turnId: fact.turnId as never,
        interaction: fact.interaction,
        generation: fact.generation,
      });
      return pending
        ? { ...base, turnId: fact.turnId, type: 'interaction_opened', payload: { interaction: pending } }
        : null;
    }
    case 'session_interaction_resolved':
      return {
        ...base,
        turnId: fact.turnId,
        type: 'interaction_resolved',
        payload: { interactionId: fact.interactionId },
      };
    case 'session_turn_ended':
      return { ...base, turnId: fact.turnId, type: 'turn_ended', payload: { outcome: fact.outcome } };
    case 'session_interrupted':
      return { ...base, turnId: fact.turnId, type: 'turn_ended', payload: { outcome: 'interrupted' } };
    case 'user_message':
      return {
        ...base,
        turnId: null,
        type: 'message',
        payload: { message: { id: fact.message.id, role: 'user', text: bounded(fact.message.text) } },
      };
    case 'assistant_turn': {
      const text = fact.turn.items
        .filter((item) => item.type === 'assistant_text')
        .map((item) => item.text)
        .join('');
      return text
        ? {
            ...base,
            turnId: null,
            type: 'message',
            payload: { message: { id: entry.ref.eventId, role: 'assistant', text: bounded(text) } },
          }
        : null;
    }
    case 'tool_started':
      return {
        ...base,
        turnId: fact.turnId ?? null,
        type: 'tool_started',
        payload: { callId: fact.toolCallId, toolName: fact.toolName },
      };
    case 'tool_result':
      return {
        ...base,
        turnId: fact.turnId ?? null,
        type: 'tool_finished',
        payload: {
          callId: fact.callId,
          output: bounded(typeof fact.output === 'string' ? fact.output : JSON.stringify(fact.output ?? '') ?? ''),
          isError: fact.status !== 'completed',
        },
      };
    case 'session_bound':
    case 'session_admitted':
    case 'session_admission_settled':
    case 'session_interaction_recovered':
    case 'session_closed':
    case 'session_init':
    case 'settings_changed':
    case 'goal_changed':
    case 'events_retracted':
    case 'context_checkpoint_created':
    case 'command_message':
    case 'approval_required':
    case 'approval_resolved':
    case 'openai_root_selector_parity':
    case 'openai_root_checkpoint_lifecycle':
    case 'assistant_journal_delta':
    case 'assistant_journal_item':
    case 'memory_injected':
    case 'subagent_started':
    case 'subagent_tool_started':
    case 'subagent_completed':
    case 'subagent_interrupted':
    case 'subagent_transferred':
    case 'subagent_question':
    case 'background_shell_started':
    case 'background_shell_completed':
    case 'background_shell_output':
    case 'error':
    case 'undo':
    case 'session_cleared':
    case 'session_rollover':
      return null;
    default:
      // Unknown and truncated legacy records remain readable storage records
      // but do not claim public lifecycle meaning.
      return null;
  }
}

/** The compatibility projection for G1's existing public protocol. */
export const projection: Projection = {
  toWire(sessionId: string, update: SessionUpdate): WireEvent | null {
    if (update.kind === 'fact') return factEvent(sessionId, update.entry);
    const base = { sessionId, seq: null, turnId: update.turnId };
    const event = update.event;
    switch (event.type) {
      case 'text_delta':
      case 'reasoning_delta':
        return { ...base, type: event.type, payload: { delta: bounded(event.delta) } };
      case 'tool_started':
        return { ...base, type: 'tool_started', payload: { callId: event.callId, toolName: event.toolName } };
      case 'tool_progress':
        return { ...base, type: 'tool_progress', payload: { callId: event.callId, chunk: bounded(event.chunk) } };
      case 'tool_finished':
        return {
          ...base,
          type: 'tool_finished',
          payload: { callId: event.callId, output: bounded(event.result.output), isError: event.result.isError },
        };
      case 'usage':
        return { ...base, type: 'usage', payload: { ...event.usage } };
      case 'retrying':
        return {
          ...base,
          type: 'retrying',
          payload: { attempt: event.attempt, delayMs: event.delayMs, errorKind: event.error.kind },
        };
      case 'compacted':
        return { ...base, type: 'compacted', payload: { replaced: event.replaced } };
      case 'subagent':
        return { ...base, type: 'subagent', payload: { agentId: event.agentId, role: event.role } };
      case 'item':
      case 'checkpoint':
      case 'turn_ended':
        return null;
    }
  },

  snapshot(sessionId: string, state: SessionState) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      status: state.status,
      model: { provider: state.model.provider, model: state.model.model },
      messages: (state.messages.length
        ? state.messages.map(toSavedMessage)
        : state.history.map(toCompatibilityMessage)
      ).filter((message): message is WireMessage => message !== null),
      pendingInteraction: state.pendingInteraction ? pendingAsLegacyWire(state.pendingInteraction) : null,
      canRetry: state.canRetry,
      seq: state.lastSeq,
    };
  },
};
