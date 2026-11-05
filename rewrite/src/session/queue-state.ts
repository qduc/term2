/** Pure queue projection. Session owns its lifetime and folds facts in accepted log order. */
import type { ContentPart, Item, ItemId } from '../model/index.js';
import type { DirectQueueEdit, DirectQueueFact, DirectQueueRecord, DirectQueueState } from './queue-types.js';

/** Empty projection; reopening then folds accepted facts without dispatching anything. */
export function createDirectQueueState(): DirectQueueState {
  return { records: [], pending: [] };
}

/** Resolve a pending id to its current payload, including edits and attachments. */
export function directQueuePending(state: DirectQueueState): readonly DirectQueueRecord[] {
  return state.pending.map((id) => {
    const record = state.records.find((item) => item.messageId === id);
    if (!record) throw new Error(`queue: pending message ${id} has no submission`);
    return record;
  });
}

/**
 * Canonical user history contributed by queue_steered, from the PRE-fact queue
 * projection. Replay uses the same conversion as live admission, so no second
 * item fact (and no torn-batch missing item window) is needed for a steer.
 */
export function directQueueSteeredInput(
  state: DirectQueueState,
  fact: Extract<DirectQueueFact, { readonly type: 'queue_steered' }>,
): readonly Item[] {
  requireActive(state, fact.turnId);
  return fact.messageIds.map((id) => {
    const record = requirePending(state, id);
    return { type: 'user_message', id: record.messageId as ItemId, content: record.content };
  });
}

/**
 * Edit the primary text part without dropping later text/image attachments.
 * Explicit attachments replace those parts; a full content edit replaces all.
 */
export function directQueueEditedContent(
  content: readonly ContentPart[],
  edit: DirectQueueEdit,
): readonly ContentPart[] {
  if ('content' in edit) return structuredClone(edit.content);
  const replacement: ContentPart = { type: 'text', text: edit.text };
  if (edit.attachments !== undefined) return [replacement, ...structuredClone(edit.attachments)];
  const index = content.findIndex((part) => part.type === 'text');
  if (index < 0) return [replacement, ...content];
  return content.map((part, offset) => (offset === index ? replacement : part));
}

/** Fold only accepted native queue facts. Unknown/stale operations belong in the planner. */
export function reduceDirectQueue(state: DirectQueueState, fact: DirectQueueFact): DirectQueueState {
  switch (fact.type) {
    case 'queue_submitted': {
      const record = fact.record;
      if (
        state.records.some(
          (item) =>
            item.messageId === record.messageId || item.request.clientRequestId === record.request.clientRequestId,
        )
      ) {
        throw new Error(`queue: duplicate submission ${record.messageId}`);
      }
      const pending = [...state.pending];
      const firstFollowUp = directQueuePending(state).findIndex((item) => item.request.delivery !== 'steer');
      const index = record.request.delivery === 'steer' && firstFollowUp >= 0 ? firstFollowUp : pending.length;
      pending.splice(index, 0, record.messageId);
      return { ...state, records: [...state.records, record], pending };
    }
    case 'queue_edited':
      requirePending(state, fact.messageId);
      return {
        ...state,
        records: state.records.map((record) =>
          record.messageId === fact.messageId ? { ...record, content: fact.content } : record,
        ),
      };
    case 'queue_retracted':
      requirePending(state, fact.messageId);
      return removePending(state, [fact.messageId], 'retracted');
    case 'queue_discarded':
      for (const id of fact.messageIds) requirePending(state, id);
      return removePending(state, fact.messageIds, 'discarded');
    case 'queue_started': {
      const record = requirePending(state, fact.messageId);
      // Replay authorizes the exact header/command/IDs and one seed per rotation.
      // This local exception selects only that real queued control record, never retained work.
      const rolloverCommandId = fact.rolloverCommandId;
      if (
        state.active ||
        record.stage !== 'queued' ||
        (rolloverCommandId !== undefined
          ? rolloverCommandId.length === 0 ||
            record.admission.kind !== 'queued' ||
            record.admission.turnId !== fact.turnId ||
            record.turnId !== fact.turnId ||
            record.request.delivery !== 'follow_up' ||
            record.request.origin?.kind !== 'control' ||
            record.request.origin.id !== 'session-rollover'
          : Boolean(state.pause) || state.pending[0] !== fact.messageId)
      ) {
        throw new Error(`queue: cannot start ${fact.messageId}`);
      }
      return {
        ...state,
        pending: state.pending.filter((id) => id !== fact.messageId),
        records: state.records.map((item) =>
          item.messageId === fact.messageId ? { ...item, stage: 'running', turnId: fact.turnId } : item,
        ),
        active: { messageId: fact.messageId, turnId: fact.turnId, phase: 'running' },
      };
    }
    case 'queue_steered': {
      requireActive(state, fact.turnId);
      if (state.active!.phase !== 'running') throw new Error('queue: cannot steer a cancelling turn');
      const ids = new Set(fact.messageIds);
      for (const id of ids) {
        const record = requirePending(state, id);
        if (record.stage !== 'pending_steer' || record.turnId !== fact.turnId)
          throw new Error(`queue: ${id} is not steering this turn`);
      }
      return {
        ...state,
        pending: state.pending.filter((id) => !ids.has(id)),
        records: state.records.map((record) => (ids.has(record.messageId) ? { ...record, stage: 'steered' } : record)),
      };
    }
    case 'queue_cancelling': {
      requireActive(state, fact.turnId);
      const next = removePending(state, fact.cancelledMessageIds, 'cancelled');
      return {
        ...next,
        active: {
          ...state.active!,
          phase: 'cancelling',
          retainedMessageIds: fact.retainedMessageIds,
          preservePendingSteers: fact.preservePendingSteers,
        },
      };
    }
    case 'queue_settled': {
      requireActive(state, fact.turnId);
      // A stop raced with natural completion still retains the user's stop intent.
      const stopping = state.active!.phase === 'cancelling' || fact.outcome === 'cancelled';
      const abandoned = directQueuePending(state).filter(
        (record) => record.stage === 'pending_steer' && record.turnId === fact.turnId,
      );
      const next =
        stopping && !fact.preservePendingSteers && !state.active!.preservePendingSteers
          ? removePending(
              state,
              abandoned.map((record) => record.messageId),
              'cancelled',
            )
          : state;
      const retained = state.active!.retainedMessageIds ?? next.pending;
      // Stop-retained follow-ups stay paused, but accepted steers get their own
      // turns first. The IDs are folded from facts so replay makes the same choice.
      const deferred = [
        ...(state.deferredStopSteers ?? []).filter((id) => next.pending.includes(id)),
        ...(state.active!.preservePendingSteers ? abandoned.map((record) => record.messageId) : []),
      ];
      const stopRetained = next.pending.some((id) => retained.includes(id));
      const shouldDefer = deferred.length > 0 && (stopRetained || Boolean(state.deferredStopSteers?.length));
      const pause =
        state.pause ??
        (next.pending.length === 0
          ? undefined
          : stopping
          ? shouldDefer
            ? undefined
            : stopRetained || state.deferredStopSteers?.length
            ? 'manual'
            : undefined
          : fact.outcome === 'interrupted'
          ? 'recovered_interrupted'
          : fact.outcome === 'failed'
          ? 'failure'
          : shouldDefer
          ? undefined
          : state.deferredStopSteers?.length
          ? 'manual'
          : undefined);
      return {
        ...next,
        active: undefined,
        pause,
        deferredStopSteers: shouldDefer ? deferred : undefined,
        records: next.records.map((record) => {
          if (record.turnId !== fact.turnId) return record;
          if (record.stage === 'running' || record.stage === 'steered')
            return { ...record, stage: 'finished', outcome: fact.outcome };
          if (record.stage === 'pending_steer') return { ...record, stage: 'queued', turnId: undefined };
          return record;
        }),
      };
    }
    case 'queue_resumed':
      if (state.active) throw new Error('queue: cannot resume during active cleanup');
      return { ...state, pause: undefined };
    case 'queue_recovered': {
      const next = state.active
        ? reduceDirectQueue(state, { type: 'queue_settled', turnId: state.active.turnId, outcome: 'interrupted' })
        : state;
      return { ...next, pause: next.pending.length ? 'recovered_interrupted' : undefined };
    }
  }
}

function requirePending(state: DirectQueueState, messageId: string): DirectQueueRecord {
  const record = state.records.find((item) => item.messageId === messageId);
  if (!record || !state.pending.includes(messageId)) throw new Error(`queue: ${messageId} is not pending`);
  return record;
}

function requireActive(state: DirectQueueState, turnId: string): void {
  if (state.active?.turnId !== turnId) throw new Error(`queue: ${turnId} does not own the foreground`);
}

function removePending(
  state: DirectQueueState,
  messageIds: readonly string[],
  stage: 'retracted' | 'discarded' | 'cancelled',
): DirectQueueState {
  const ids = new Set(messageIds);
  const pending = state.pending.filter((id) => !ids.has(id));
  const deferred = state.deferredStopSteers?.filter((id) => !ids.has(id));
  return {
    ...state,
    pending,
    pause: !pending.length
      ? undefined
      : state.pause ?? (!state.active && state.deferredStopSteers?.length && !deferred?.length ? 'manual' : undefined),
    deferredStopSteers: deferred,
    active: state.active
      ? {
          ...state.active,
          retainedMessageIds: state.active.retainedMessageIds?.filter((id) => !ids.has(id)),
        }
      : undefined,
    records: state.records.map((record) => (ids.has(record.messageId) ? { ...record, stage } : record)),
  };
}
