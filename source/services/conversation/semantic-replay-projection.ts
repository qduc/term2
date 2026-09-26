import { isTruncatedLogEvent, type PersistedLogEvent } from '../logging/conversation-log-events.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import { replayEvents, type RestoredState } from './conversation-replay.js';

export type SemanticReplayProjection =
  | { status: 'projected'; state: RestoredState }
  | { status: 'unsupported'; reason: 'legacy_undo_snapshot'; seq: number };

const isProviderOpaqueItem = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as { type?: unknown }).type === 'provider_opaque';

const withoutProviderOpaqueItems = (event: PersistedLogEvent): PersistedLogEvent | null => {
  if (isTruncatedLogEvent(event)) return event;
  if (event.type === 'assistant_turn') {
    const { snapshot: _snapshot, state: _state, ...semanticEvent } = event;
    return {
      ...semanticEvent,
      turn: { items: event.turn.items.filter((item) => !isProviderOpaqueItem(item)) },
    };
  }
  if (event.type === 'assistant_journal_item' && isProviderOpaqueItem(event.item)) return null;
  return event;
};

/**
 * Comparison-only replay from semantic events. Snapshot and provider-chain
 * adjuncts are intentionally excluded; legacy snapshot-only undo is reported
 * as unsupported instead of guessed from its materialized state.
 */
export function projectSemanticEvents(envelopes: readonly PersistedLogEnvelope[]): SemanticReplayProjection {
  const legacyUndo = envelopes.find((envelope) => envelope.event.type === 'undo');
  if (legacyUndo) return { status: 'unsupported', reason: 'legacy_undo_snapshot', seq: legacyUndo.seq };

  const semanticEnvelopes: PersistedLogEnvelope[] = [];
  for (const envelope of envelopes) {
    const event = withoutProviderOpaqueItems(envelope.event);
    if (event) semanticEnvelopes.push({ ...envelope, event });
  }

  return { status: 'projected', state: replayEvents(semanticEnvelopes) };
}
