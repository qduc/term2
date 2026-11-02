/** Projection of native accepted queue facts. No admission planner, effects, or writer. */
import type { DirectQueueFact, DirectQueueRecord, DirectQueueState } from '../session/direct-queue-types.js';
import { directQueuePending } from '../session/direct-queue-state.js';
import type { WireQueueChange, WireSubmissionRecord, WireTurnResult, WireSnapshot } from './direct-wire.js';
import { parseWireOrigin } from './direct-parse.js';
import { contentText, publicContent } from './direct-public.js';

/** Preserve pending content, correlation and pause reason from the authoritative queue. */
export function publicQueue(
  queue: DirectQueueState,
  turnResults: readonly WireTurnResult[] = [],
): Pick<WireSnapshot, 'queue' | 'queueState' | 'queuePauseReason' | 'submissions'> {
  return {
    queue: directQueuePending(queue).map((record) => {
      const content = publicContent(record.content);
      return {
        messageId: record.messageId,
        clientRequestId: record.request.clientRequestId,
        text: contentText(content),
        content,
        delivery: record.stage === 'pending_steer' ? ('steering' as const) : ('queued' as const),
        ...(record.turnId ? { turnId: record.turnId } : {}),
        receivedAt: record.receivedAt,
        ...(record.request.origin ? { origin: parseWireOrigin(record.request.origin) } : {}),
      };
    }),
    submissions: queue.records.map((record) => publicQueueRecord(record, turnResults)),
    queueState:
      queue.active?.phase === 'cancelling' ? 'cancelling' : queue.active ? 'running' : queue.pause ? 'paused' : 'idle',
    queuePauseReason: queue.pause ?? null,
  };
}

/** Retain the accepted original/current body and correlation, not a rewritten input. */
function publicQueueRecord(
  record: DirectQueueRecord,
  turnResults: readonly WireTurnResult[] = [],
): WireSubmissionRecord {
  const result = record.turnId ? turnResults.find((result) => result.turnId === record.turnId) : undefined;
  return {
    clientRequestId: record.request.clientRequestId,
    messageId: record.messageId,
    delivery: record.request.delivery,
    ...(record.request.origin ? { origin: parseWireOrigin(record.request.origin) } : {}),
    receivedAt: record.receivedAt,
    originalContent: publicContent(record.request.content),
    content: publicContent(record.content),
    admission: { ...record.admission },
    stage: record.stage,
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.outcome ? { outcome: record.outcome } : {}),
    finalText: result?.outcome === 'completed' ? result.finalText ?? null : null,
  };
}
/** One native fact body at its original cursor. Aggregate IDs are not rejection events. */
export function publicQueueChange(fact: DirectQueueFact): WireQueueChange {
  switch (fact.type) {
    case 'queue_submitted':
      return { type: fact.type, record: publicQueueRecord(fact.record) };
    case 'queue_edited':
      return { type: fact.type, messageId: fact.messageId, content: publicContent(fact.content) };
    case 'queue_retracted':
      return { type: fact.type, messageId: fact.messageId };
    case 'queue_discarded':
      return { type: fact.type, messageIds: [...fact.messageIds] };
    case 'queue_started':
      return { type: fact.type, messageId: fact.messageId, turnId: fact.turnId };
    case 'queue_steered':
      return { type: fact.type, messageIds: [...fact.messageIds], turnId: fact.turnId };
    case 'queue_cancelling':
      return {
        type: fact.type,
        turnId: fact.turnId,
        cancelledMessageIds: [...fact.cancelledMessageIds],
        retainedMessageIds: [...fact.retainedMessageIds],
        ...(fact.preservePendingSteers ? { preservePendingSteers: true } : {}),
      };
    case 'queue_settled':
      return {
        type: fact.type,
        turnId: fact.turnId,
        outcome: fact.outcome,
        ...(fact.preservePendingSteers !== undefined ? { preservePendingSteers: fact.preservePendingSteers } : {}),
      };
    case 'queue_resumed':
      return { type: fact.type };
    case 'queue_recovered':
      return { type: fact.type };
  }
}
