import type { LogEntry, Project, SessionId, SessionState } from './index.js';

export function initialState(id: SessionId): SessionState {
  return {
    id,
    status: 'idle',
    workspace: { root: '', access: 'read', target: 'local' },
    model: { provider: '', model: '' },
    history: [],
    activeTurnId: null,
    pendingInteraction: null,
    queue: [],
    canRetry: false,
    lastCheckpoint: null,
    lastSeq: 0,
  };
}

export const project: Project = (state, entry: LogEntry) => {
  const next = { ...state, lastSeq: entry.seq };
  const fact = entry.fact;
  switch (fact.type) {
    case 'session_created':
      return { ...next, workspace: fact.workspace, model: fact.model };
    case 'input_queued':
      return { ...next, queue: [...state.queue, { requestId: fact.requestId, items: fact.items }] };
    case 'turn_started':
      return {
        ...next,
        status: 'running',
        activeTurnId: fact.turnId,
        canRetry: false,
        lastCheckpoint: null,
        queue: state.queue.filter((queued) => queued.requestId !== fact.requestId),
      };
    case 'item_committed':
      return { ...next, history: [...state.history, fact.item] };
    case 'checkpoint_saved':
      return { ...next, lastCheckpoint: fact.checkpoint };
    case 'interaction_opened':
      return {
        ...next,
        status: 'awaiting_interaction',
        pendingInteraction: { interactionId: fact.interactionId, turnId: fact.turnId, approvals: fact.approvals },
      };
    case 'interaction_resolved':
      return { ...next, status: 'running', pendingInteraction: null };
    case 'turn_ended':
      return {
        ...next,
        status: 'idle',
        activeTurnId: null,
        lastCheckpoint: null,
        canRetry: fact.outcome === 'failed',
      };
    case 'turn_interrupted':
      return {
        ...next,
        status: 'interrupted',
        activeTurnId: null,
        pendingInteraction: null,
        lastCheckpoint: null,
        canRetry: true,
      };
    case 'history_compacted':
      return { ...next, history: fact.history };
    case 'model_changed':
      return { ...next, model: fact.model };
  }
};
