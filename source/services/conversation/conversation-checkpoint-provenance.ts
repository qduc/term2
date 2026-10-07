import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { createHash } from 'node:crypto';
import { isLocalContextSummary } from '../../contracts/provider-input.js';
import { isTruncatedLogEvent, type EventReference } from '../logging/conversation-log-events.js';
import type { PersistedLogEnvelope } from './conversation-decoder.js';
import { projectConversationMessage } from './conversation-message-projection.js';

const referenceOf = (envelope: PersistedLogEnvelope): EventReference | null =>
  envelope.logId && envelope.eventId ? { logId: envelope.logId, eventId: envelope.eventId } : null;

const refKey = (ref: EventReference): string => JSON.stringify([ref.logId, ref.eventId]);
const itemKey = (item: unknown): string => JSON.stringify(item);

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

interface SourceTurn {
  user: EventReference;
  assistants: EventReference[];
}

/**
 * Resolve exact source events for a locally summarized prefix. The live
 * history determines coverage; persisted envelopes supply the durable ids.
 * Any ambiguity fails closed so compaction can still succeed without claiming
 * provenance it cannot prove.
 */
export function resolveCheckpointSourceRefs(input: {
  envelopes: readonly PersistedLogEnvelope[];
  history: readonly ProviderInputItem[];
  hotTail: readonly ProviderInputItem[];
}): EventReference[] | null {
  const genuineUsers = (items: readonly ProviderInputItem[]): number =>
    items.filter((item) => {
      const message = projectConversationMessage(item);
      return message?.role === 'user' && !message.isSynthetic;
    }).length;

  // The reducer prepends protected user requests to its verbatim suffix.
  // Identify the actual cut by suffix identity instead of subtracting user counts.
  let suffixLength = 0;
  while (
    suffixLength < input.history.length &&
    suffixLength < input.hotTail.length &&
    itemKey(input.history[input.history.length - 1 - suffixLength]) ===
      itemKey(input.hotTail[input.hotTail.length - 1 - suffixLength])
  )
    suffixLength++;
  const coldPrefix = input.history.slice(0, input.history.length - suffixLength);
  const coldUserTurns = genuineUsers(coldPrefix);
  if (coldUserTurns <= 0) return null;

  const retracted = new Set<string>();
  for (const envelope of input.envelopes) {
    if (isTruncatedLogEvent(envelope.event)) continue;
    if (envelope.event.type !== 'events_retracted') continue;
    for (const ref of envelope.event.refs) retracted.add(refKey(ref));
  }

  const turns: SourceTurn[] = [];
  let current: SourceTurn | undefined;
  for (const envelope of input.envelopes) {
    const ref = referenceOf(envelope);
    if (!ref || isTruncatedLogEvent(envelope.event)) continue;
    if (envelope.event.type === 'user_message') {
      current = { user: ref, assistants: [] };
      turns.push(current);
    } else if (envelope.event.type === 'assistant_turn' && current) {
      current.assistants.push(ref);
    } else if (envelope.event.type === 'undo' || envelope.event.type === 'session_cleared') {
      current = undefined;
      turns.length = 0;
    }
  }

  const historyUserTurns = genuineUsers(input.history);
  const liveTurns = turns.slice(-historyUserTurns);
  if (liveTurns.length !== historyUserTurns) return null;
  const coveredTurns = liveTurns.slice(0, coldUserTurns);
  if (coveredTurns.length !== coldUserTurns || coveredTurns.some((turn) => turn.assistants.length === 0)) return null;

  const refs: EventReference[] = [];
  const add = (ref: EventReference): boolean => {
    const key = refKey(ref);
    if (retracted.has(key)) return false;
    if (!refs.some((existing) => refKey(existing) === key)) refs.push(ref);
    return true;
  };

  // A prior local checkpoint in the replaced prefix carries coverage of the
  // older source turns it summarizes. Preserve those refs transitively.
  for (const item of coldPrefix) {
    if (!isLocalContextSummary(item)) continue;
    const prior = input.envelopes.find(
      (envelope) =>
        !isTruncatedLogEvent(envelope.event) &&
        envelope.event.type === 'context_checkpoint_created' &&
        itemKey(envelope.event.item) === itemKey(item),
    );
    if (!prior || isTruncatedLogEvent(prior.event) || prior.event.type !== 'context_checkpoint_created') return null;
    if (
      prior.event.sourceDigest !== undefined &&
      createCheckpointSourceDigest(prior.event.sourceRefs, input.envelopes) !== prior.event.sourceDigest
    ) {
      return null;
    }
    for (const ref of prior.event.sourceRefs) if (!add(ref)) return null;
  }

  for (const turn of coveredTurns) {
    if (!add(turn.user)) return null;
    for (const assistant of turn.assistants) if (!add(assistant)) return null;
  }
  return refs.length > 0 ? refs : null;
}
