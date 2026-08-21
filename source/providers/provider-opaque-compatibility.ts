/**
 * Which provider-opaque items a given wire lane may replay.
 *
 * An opaque item is a provider-private payload — encrypted reasoning, a
 * continuity blob, a native compaction marker — that Term2 stores verbatim and
 * hands back to the lane that produced it. Handing one to a *different* lane is
 * never valid: the payload is signed or encrypted for its origin, and the
 * receiving API rejects or misreads it.
 *
 * Two things follow, and they are easy to conflate:
 *
 * 1. **A foreign opaque item must not be sent.** That is a hard rule.
 * 2. **Encountering one is not an error.** It is the ordinary consequence of
 *    switching providers on an existing conversation. The item is inert
 *    baggage; the rest of the history is still perfectly replayable.
 *
 * Term2 used to conflate them and throw on (1), which turned every
 * provider switch on a reasoning-bearing conversation into a dead session — the
 * item stays in history forever, so every subsequent turn threw again. The
 * correct handling is to drop the item and continue. The conversion is lossy,
 * but a provider switch is inherently lossy, and the loss is confined to state
 * the new provider could not have used.
 *
 * The tag is a *lane* identity, not a provider id. The Responses lane tags its
 * items `openai` no matter which configured provider routes to it, because the
 * payload shape is the Responses API's. Chat Completions tags items with the
 * configured provider name, because two providers of the same
 * `openai-compatible` type spell reasoning differently.
 */

/** The lane tag every OpenAI Responses adapter produces and accepts. */
export const OPENAI_RESPONSES_OPAQUE_TAG = 'openai';

/**
 * Grok speaks the Responses wire shape but is a different vendor, so its
 * encrypted reasoning and native items are not interchangeable with OpenAI's.
 * The lane comment above says the tag names the wire shape rather than the
 * provider; that held only while OpenAI and Codex were the sole Responses
 * providers, both of them OpenAI. A second vendor on the same shape needs its
 * own lane, or a provider switch would hand one vendor another's ciphertext.
 */
export const GROK_RESPONSES_OPAQUE_TAG = 'grok';

/**
 * Conversations recorded before Chat Completions opaque items carried the
 * configured provider name were tagged with the shared type. Items from that
 * window still replay on any openai-compatible provider; a genuinely foreign
 * tag is still refused.
 */
export const LEGACY_SHARED_PROVIDER_TAG = 'openai-compatible';

/**
 * Reads the lane tag off either spelling of an opaque item: the
 * `providerOpaque` marker restored onto a replayed provider item, or the
 * `{ type: 'provider_opaque', provider, item }` envelope.
 */
export function providerOpaqueTagOf(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  if (record.type === 'provider_opaque' && typeof record.provider === 'string') return record.provider;
  const marker = record.providerOpaque;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return undefined;
  const provider = (marker as Record<string, unknown>).provider;
  return typeof provider === 'string' ? provider : undefined;
}

/** True when `item` is opaque and belongs to a lane other than `laneTag`. */
export function isForeignProviderOpaque(item: unknown, laneTag: string): boolean {
  const tag = providerOpaqueTagOf(item);
  if (tag === undefined) return false;
  return !acceptsProviderOpaqueTag(tag, laneTag);
}

/** True when a lane may replay an opaque item carrying `tag`. */
export function acceptsProviderOpaqueTag(tag: string, laneTag: string): boolean {
  if (tag === laneTag) return true;
  // The legacy shared tag is only honoured by Chat Completions lanes, which are
  // the only lanes that ever produced it. The Responses lane must not adopt it.
  return laneTag !== OPENAI_RESPONSES_OPAQUE_TAG && tag === LEGACY_SHARED_PROVIDER_TAG;
}
