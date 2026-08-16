import { describe, expect, it } from 'vitest';
import {
  LEGACY_SHARED_PROVIDER_TAG,
  OPENAI_RESPONSES_OPAQUE_TAG,
  acceptsProviderOpaqueTag,
  isForeignProviderOpaque,
  providerOpaqueTagOf,
} from './provider-opaque-compatibility.js';

describe('providerOpaqueTagOf', () => {
  it('reads the tag off the provider_opaque envelope', () => {
    expect(providerOpaqueTagOf({ type: 'provider_opaque', provider: 'openai', item: {} })).toBe('openai');
  });

  // Replayed history carries the marker restored onto the raw provider item
  // rather than the envelope, so both spellings must resolve to the same tag.
  it('reads the tag off the restored providerOpaque marker', () => {
    expect(providerOpaqueTagOf({ type: 'compaction', providerOpaque: { provider: 'openai' } })).toBe('openai');
  });

  it('returns undefined for an ordinary item', () => {
    expect(providerOpaqueTagOf({ type: 'message', role: 'user' })).toBeUndefined();
    expect(providerOpaqueTagOf({ providerOpaque: 'not-an-object' })).toBeUndefined();
    expect(providerOpaqueTagOf(null)).toBeUndefined();
  });
});

describe('acceptsProviderOpaqueTag', () => {
  it('accepts a lane its own items', () => {
    expect(acceptsProviderOpaqueTag('openrouter', 'openrouter')).toBe(true);
    expect(acceptsProviderOpaqueTag(OPENAI_RESPONSES_OPAQUE_TAG, OPENAI_RESPONSES_OPAQUE_TAG)).toBe(true);
  });

  it('refuses another lane', () => {
    expect(acceptsProviderOpaqueTag('deepseek', 'openrouter')).toBe(false);
    expect(acceptsProviderOpaqueTag('codex', OPENAI_RESPONSES_OPAQUE_TAG)).toBe(false);
  });

  // Items recorded before Chat Completions tagged by configured provider carry
  // the shared type. They still replay on a chat lane.
  it('honours the legacy shared tag on a chat-completions lane', () => {
    expect(acceptsProviderOpaqueTag(LEGACY_SHARED_PROVIDER_TAG, 'openrouter')).toBe(true);
  });

  // The Responses lane never produced the legacy tag, so adopting it there would
  // splice a chat-completions reasoning payload into a Responses request.
  it('does not honour the legacy shared tag on the Responses lane', () => {
    expect(acceptsProviderOpaqueTag(LEGACY_SHARED_PROVIDER_TAG, OPENAI_RESPONSES_OPAQUE_TAG)).toBe(false);
  });
});

describe('isForeignProviderOpaque', () => {
  it('is false for items that are not opaque at all', () => {
    expect(isForeignProviderOpaque({ type: 'message', role: 'user' }, 'openrouter')).toBe(false);
  });

  it('is true only for an opaque item belonging to another lane', () => {
    const own = { type: 'provider_opaque', provider: 'openai', item: {} };
    const foreign = { type: 'provider_opaque', provider: 'codex', item: {} };
    expect(isForeignProviderOpaque(own, OPENAI_RESPONSES_OPAQUE_TAG)).toBe(false);
    expect(isForeignProviderOpaque(foreign, OPENAI_RESPONSES_OPAQUE_TAG)).toBe(true);
  });
});
