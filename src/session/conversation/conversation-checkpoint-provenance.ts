import { createHash } from 'node:crypto';

import { isTruncatedLogEvent, type EventReference } from '../logging/conversation-log-events.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';

const referenceOf = (envelope: PersistedLogEnvelope): EventReference | null =>
  envelope.logId && envelope.eventId ? { logId: envelope.logId, eventId: envelope.eventId } : null;

const refKey = (ref: EventReference): string => JSON.stringify([ref.logId, ref.eventId]);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

/** SHA-256 over ordered identities and canonical event payloads; envelope metadata is excluded. */
export function createCheckpointSourceDigest(
  refs: readonly EventReference[],
  envelopes: readonly PersistedLogEnvelope[],
): string | null {
  const byRef = new Map<string, PersistedLogEnvelope>();
  for (const envelope of envelopes) {
    const ref = referenceOf(envelope);
    if (!ref || byRef.has(refKey(ref))) return null;
    byRef.set(refKey(ref), envelope);
  }
  const seen = new Set<string>();
  const sources: { ref: EventReference; event: unknown }[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    const source = byRef.get(key);
    if (!source || seen.has(key) || isTruncatedLogEvent(source.event)) return null;
    seen.add(key);
    sources.push({ ref: { logId: ref.logId, eventId: ref.eventId }, event: source.event });
  }
  const payload = canonicalJson({ version: 1, sources });
  return `sha256:${createHash('sha256')
    .update('term2-local-checkpoint-source-v1\0')
    .update(payload, 'utf8')
    .digest('hex')}`;
}
