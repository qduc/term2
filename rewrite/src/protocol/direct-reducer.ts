/** Pure shared public-state reducer; clients and snapshots use this same fold.
 * Local UI scroll/menu/composer state belongs to the client, not this projection.
 */
import type { WireEvent, WireMessage, WireSnapshot } from './direct-wire.js';

type Identified = { readonly id: string };
function replace<T extends Identified>(items: readonly T[], next: T): readonly T[] {
  return items.some(item => item.id === next.id)
    ? items.map(item => item.id === next.id ? next : item) : [...items, next];
}
function message(items: readonly WireMessage[], next: WireMessage, draftId?: string): readonly WireMessage[] {
  const index = items.findIndex(item => item.id === next.id || item.id === draftId);
  if (index < 0) return [...items, next];
  return items.flatMap((item, at) => at === index ? [next] : item.id === next.id || item.id === draftId ? [] : [item]);
}
function delta(state: WireSnapshot, event: Extract<WireEvent, { type: 'text_delta' }>): WireSnapshot {
  const payload = event.payload;
  const previous = state.messages.find(item => item.id === payload.messageId);
  const text = (previous?.text ?? '') + payload.delta;
  return { ...state, messages: message(state.messages, {
    id: payload.messageId, role: 'assistant', content: [{ type: 'text', text }], text, draft: true,
    ...(event.turnId ? { turnId: event.turnId } : {}), modelStep: payload.modelStep,
  }) };
}
/** Reject cross-session input; seq only advances on actual durable event references. */
export function reduceWireEvent(state: WireSnapshot, event: WireEvent): WireSnapshot {
  if (event.sessionId !== state.sessionId) throw new Error('Wire event belongs to a different session');
  const next = reducePayload(state, event);
  return event.seq === null ? next : { ...next, seq: Math.max(next.seq ?? 0, event.seq) };
}
function reducePayload(state: WireSnapshot, event: WireEvent): WireSnapshot {
  switch (event.type) {
    case 'snapshot': return event.payload.snapshot;
    case 'turn_started': return { ...state,
      messages: event.payload.input.reduce((items, item) => message(items, item), state.messages),
      ...(event.payload.foreground ? { status: 'running' as const, activeTurnId: event.turnId, reasoning: '', lastError: null } : {}),
    };
    case 'text_delta': return delta(state, event);
    case 'reasoning_delta': return { ...state, reasoning: state.reasoning + event.payload.delta };
    case 'message': return { ...state, messages: message(state.messages, event.payload.message, event.payload.replacesDraftId) };
    case 'tool_called':
    case 'tool_started': return { ...state, tools: replace(state.tools.map(tool => ({ ...tool, id: tool.executionId })),
      { ...event.payload.tool, id: event.payload.tool.executionId }).map(({ id: _id, ...tool }) => tool) };
    case 'tool_progress': return { ...state, tools: state.tools.map(tool => tool.executionId === event.payload.executionId
      ? { ...tool, progress: (tool.progress ?? '') + event.payload.chunk } : tool) };
    case 'tool_finished': return { ...state, tools: state.tools.map(tool => tool.executionId === event.payload.executionId
      ? { ...tool, status: 'completed', output: event.payload.output, isError: event.payload.isError } : tool) };
    case 'interaction_opened': return { ...state,
      pendingInteractions: [...state.pendingInteractions.filter(item => item.requestId !== event.payload.interaction.requestId), event.payload.interaction],
      ...(state.activeTurnId === event.payload.interaction.turnId ? { status: 'awaiting_interaction' as const } : {}),
    };
    case 'interaction_resolved': {
      const pendingInteractions = state.pendingInteractions.filter(item => item.requestId !== event.payload.requestId);
      const awaiting = pendingInteractions.some(item => item.turnId === state.activeTurnId);
      return { ...state, pendingInteractions, ...(state.activeTurnId ? { status: awaiting ? 'awaiting_interaction' : 'running' } : {}) };
    }
    case 'admission': return { ...state, admissions: [...state.admissions.filter(item => item.clientRequestId !== event.payload.admission.clientRequestId), event.payload.admission] };
    case 'usage': return { ...state, usage: {
      inputTokens: state.usage.inputTokens + event.payload.usage.inputTokens,
      outputTokens: state.usage.outputTokens + event.payload.usage.outputTokens,
      cachedInputTokens: state.usage.cachedInputTokens + event.payload.usage.cachedInputTokens,
    } };
    case 'status_changed': return { ...state, status: event.payload.status };
    case 'turn_ended': return { ...state,
      pendingInteractions: state.pendingInteractions.filter(item => item.turnId !== event.turnId),
      ...(state.activeTurnId === event.turnId || state.activeTurnId === null
        ? { activeTurnId: null, status: event.payload.outcome === 'interrupted' ? 'interrupted' as const : 'idle' as const } : {}),
      lastError: event.payload.error ?? state.lastError,
      terminal: event.turnId ? { turnId: event.turnId, ...event.payload } : state.terminal,
      tools: state.tools.map(tool => tool.turnId === event.turnId && tool.status === 'started' ? { ...tool, status: 'unknown' } : tool),
    };
    case 'retry_eligibility': return { ...state, retryEligibility: event.payload };
    case 'configuration': return { ...state, model: event.payload.model ?? state.model, configuration: { ...state.configuration, ...event.payload } };
    case 'queue_changed': return { ...state, queue: event.payload.entries, queueState: event.payload.state };
    case 'task_changed': return { ...state, tasks: replace(state.tasks, event.payload.task) };
    case 'cost': return { ...state, cost: event.payload };
    case 'notice': return { ...state, notices: [...state.notices, event.payload] };
    case 'goal': return { ...state, goal: event.payload.goal };
    case 'verification': return { ...state, verification: event.payload.verification };
    case 'error': return { ...state, lastError: event.payload.error };
    // Their detailed presentation is event-driven; no invented durable policy/state.
    case 'retrying':
    case 'compacted':
    case 'subagent': return state;
  }
}
