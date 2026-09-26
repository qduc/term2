import { isTruncatedLogEvent, type PersistedLogEvent } from '../logging/conversation-log-events.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import { replayEvents, type RestoredState } from './conversation-replay.js';

export type SemanticReplayProjection =
  | { status: 'projected'; state: RestoredState }
  | { status: 'unsupported'; reason: 'legacy_undo_snapshot' | 'unresolved_retraction_refs'; seq: number };

const refKey = (ref: { logId: string; eventId: string }): string => JSON.stringify([ref.logId, ref.eventId]);
const envelopeRefKey = (envelope: PersistedLogEnvelope): string | null =>
  envelope.logId && envelope.eventId ? refKey({ logId: envelope.logId, eventId: envelope.eventId }) : null;

const isProviderOpaqueItem = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as { type?: unknown }).type === 'provider_opaque';

const withoutProviderOpaqueItems = (
  event: PersistedLogEvent,
  excludeProviderOpaque: boolean,
  excludeCompatibilitySnapshots: boolean,
): PersistedLogEvent | null => {
  if (isTruncatedLogEvent(event)) return event;
  if (event.type === 'assistant_turn') {
    const { snapshot: _snapshot, state: _state, ...semanticEvent } = event;
    return {
      ...semanticEvent,
      ...(excludeCompatibilitySnapshots
        ? {}
        : {
            ...(event.snapshot ? { snapshot: event.snapshot } : {}),
            ...(event.state ? { state: event.state } : {}),
          }),
      turn: {
        items: excludeProviderOpaque
          ? event.turn.items.filter((item) => !isProviderOpaqueItem(item))
          : event.turn.items,
      },
    };
  }
  if (excludeProviderOpaque && event.type === 'assistant_journal_item' && isProviderOpaqueItem(event.item)) return null;
  return event;
};

/**
 * Comparison-only replay from semantic events. Snapshot and provider-chain
 * adjuncts are intentionally excluded; legacy snapshot-only undo is reported
 * as unsupported instead of guessed from its materialized state.
 */
export function projectSemanticEvents(
  envelopes: readonly PersistedLogEnvelope[],
  options: { diagnosticIncludeProviderOpaque?: boolean; diagnosticIncludeCompatibilitySnapshots?: boolean } = {},
): SemanticReplayProjection {
  const legacyUndo = envelopes.find((envelope) => envelope.event.type === 'undo');
  if (legacyUndo) return { status: 'unsupported', reason: 'legacy_undo_snapshot', seq: legacyUndo.seq };

  const eventByRef = new Map(
    envelopes.flatMap((envelope) => {
      const key = envelopeRefKey(envelope);
      return key ? [[key, envelope] as const] : [];
    }),
  );
  const retractedRefs = new Set<string>();
  for (const envelope of envelopes) {
    if (isTruncatedLogEvent(envelope.event)) continue;
    if (envelope.event.type !== 'events_retracted') continue;
    for (const ref of envelope.event.refs) {
      const key = refKey(ref);
      const target = eventByRef.get(key);
      if (!target || target.event.type === 'events_retracted' || target.seq >= envelope.seq) {
        return { status: 'unsupported', reason: 'unresolved_retraction_refs', seq: envelope.seq };
      }
      retractedRefs.add(key);
    }
  }

  const semanticEnvelopes: PersistedLogEnvelope[] = [];
  const checkpoints: Array<{ seq: number; sourceRefs: { logId: string; eventId: string }[]; item: unknown }> = [];
  for (const envelope of envelopes) {
    if (isTruncatedLogEvent(envelope.event)) {
      semanticEnvelopes.push(envelope);
      continue;
    }
    const key = envelopeRefKey(envelope);
    if (key && retractedRefs.has(key)) continue;
    if (envelope.event.type === 'events_retracted') continue;
    if (envelope.event.type === 'context_checkpoint_created') {
      checkpoints.push({ seq: envelope.seq, sourceRefs: envelope.event.sourceRefs, item: envelope.event.item });
      continue;
    }
    const event = withoutProviderOpaqueItems(
      envelope.event,
      !options.diagnosticIncludeProviderOpaque,
      !options.diagnosticIncludeCompatibilitySnapshots,
    );
    if (event) semanticEnvelopes.push({ ...envelope, event });
  }

  const state = replayEvents(semanticEnvelopes);
  for (const checkpoint of checkpoints) {
    const coversRetractedSource = checkpoint.sourceRefs.some((ref) => retractedRefs.has(refKey(ref)));
    const sourceRefsPrecedeCheckpoint = checkpoint.sourceRefs.every((ref) => {
      const source = eventByRef.get(refKey(ref));
      return source !== undefined && source.seq < checkpoint.seq;
    });
    if (!coversRetractedSource && sourceRefsPrecedeCheckpoint && !isProviderOpaqueItem(checkpoint.item)) {
      state.history.push(structuredClone(checkpoint.item) as (typeof state.history)[number]);
    }
  }
  return { status: 'projected', state };
}
