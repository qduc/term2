import type { Item } from '../model/index.js';
import type { LogEntry, SessionState, SessionUpdate } from '../session/index.js';
import { PROTOCOL_VERSION, type Projection, type WireEvent, type WireMessage } from './index.js';

const MAX_TEXT = 8_192;
const bounded = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

function toMessage(item: Item): WireMessage | null {
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

function factEvent(sessionId: string, entry: LogEntry): WireEvent | null {
  const base = { sessionId, seq: entry.seq };
  const fact = entry.fact;
  switch (fact.type) {
    case 'turn_started':
      return { ...base, turnId: fact.turnId, type: 'turn_started', payload: {} };
    case 'item_committed': {
      const message = toMessage(fact.item);
      return message ? { ...base, turnId: fact.turnId, type: 'message', payload: { message } } : null;
    }
    case 'interaction_opened':
      return {
        ...base,
        turnId: fact.turnId,
        type: 'interaction_opened',
        payload: {
          interaction: {
            interactionId: fact.interactionId,
            approvals: fact.approvals.map((approval) => ({
              callId: approval.callId,
              toolName: approval.toolName,
              summary: bounded(approval.requirement.summary),
              risk: approval.requirement.risk,
              ...(approval.agentId ? { agentId: approval.agentId } : {}),
            })),
          },
        },
      };
    case 'interaction_resolved':
      return { ...base, turnId: null, type: 'interaction_resolved', payload: { interactionId: fact.interactionId } };
    case 'turn_ended':
      return { ...base, turnId: fact.turnId, type: 'turn_ended', payload: { outcome: fact.outcome } };
    case 'turn_interrupted':
      return { ...base, turnId: fact.turnId, type: 'turn_ended', payload: { outcome: 'interrupted' } };
    // Internal facts: checkpoints carry history and provider state, which clients never see.
    case 'session_created':
    case 'input_queued':
    case 'checkpoint_saved':
    case 'history_compacted':
    case 'model_changed':
      return null;
  }
}

/** The single projection from session updates to public events. */
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
      // Persisted through facts instead.
      case 'item':
      case 'checkpoint':
      case 'turn_ended':
        return null;
    }
  },

  snapshot(sessionId: string, state: SessionState) {
    const pending = state.pendingInteraction;
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      status: state.status,
      model: { provider: state.model.provider, model: state.model.model },
      messages: state.history.flatMap((item) => toMessage(item) ?? []),
      pendingInteraction: pending
        ? {
            interactionId: pending.interactionId,
            approvals: pending.approvals.map((approval) => ({
              callId: approval.callId,
              toolName: approval.toolName,
              summary: bounded(approval.requirement.summary),
              risk: approval.requirement.risk,
            })),
          }
        : null,
      canRetry: state.canRetry,
      seq: state.lastSeq,
    };
  },
};
