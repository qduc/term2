/** Projection of native accepted queue facts. No admission planner, effects, or writer. */
import type { DirectQueueState } from '../session/direct-queue-types.js';
import { directQueuePending } from '../session/direct-queue-state.js';
import type { WireTurnResult, WireSnapshot } from './direct-wire.js';
import { parseWireOrigin } from './direct-parse.js';
import { contentText, publicContent } from './direct-public.js';

/** Preserve pending content, correlation and pause reason from the authoritative queue. */
export function publicQueue(queue: DirectQueueState, turnResults: readonly WireTurnResult[] = []): Pick<WireSnapshot, 'queue' | 'queueState' | 'queuePauseReason' | 'submissions'> {
  return {
    queue: directQueuePending(queue).map(record => {
      const content = publicContent(record.content);
      return { messageId: record.messageId, clientRequestId: record.request.clientRequestId,
        text: contentText(content), content, delivery: record.stage === 'pending_steer' ? 'steering' as const : 'queued' as const,
        ...(record.turnId ? { turnId: record.turnId } : {}), receivedAt: record.receivedAt,
        ...(record.request.origin ? { origin: parseWireOrigin(record.request.origin) } : {}),
      };
    }),
    submissions: queue.records.map(record => {
      const result = record.turnId ? turnResults.find(result => result.turnId === record.turnId) : undefined;
      return { clientRequestId: record.request.clientRequestId, messageId: record.messageId,
        delivery: record.request.delivery, ...(record.request.origin ? { origin: parseWireOrigin(record.request.origin) } : {}),
        receivedAt: record.receivedAt, originalContent: publicContent(record.request.content), content: publicContent(record.content),
        admission: { ...record.admission }, stage: record.stage,
        ...(record.turnId ? { turnId: record.turnId } : {}), ...(record.outcome ? { outcome: record.outcome } : {}), finalText: result?.outcome === 'completed' ? result.finalText ?? null : null,
      };
    }),
    queueState: queue.active?.phase === 'cancelling' ? 'cancelling' : queue.active ? 'running' : queue.pause ? 'paused' : 'idle',
    queuePauseReason: queue.pause ?? null,
  };
}
