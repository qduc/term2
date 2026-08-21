import { describe, it, expect } from 'vitest';
import { normalizeResponseEvent, createResponseEventNormalizationState } from './openai-responses-model.js';
import { GROK_RESPONSES_OPAQUE_TAG, isForeignProviderOpaque } from './provider-opaque-compatibility.js';

// xAI encrypts reasoning with its own key. The Responses lane used to tag every
// item `openai` on the theory that the tag names the wire shape, which held
// while OpenAI and Codex were the only Responses providers. Grok breaks that:
// replaying an xAI blob to OpenAI (or the reverse) hands one vendor another
// vendor's ciphertext, which the receiving API rejects.
describe('Grok Responses items stay in the Grok lane', () => {
  it('tags provider-native items with the grok lane, not openai', () => {
    const state = createResponseEventNormalizationState();
    const completion: any = normalizeResponseEvent(
      {
        type: 'response.completed',
        response: { id: 'resp-1', status: 'completed', output: [{ type: 'compaction', id: 'c1' }] },
      },
      state,
      GROK_RESPONSES_OPAQUE_TAG,
    );

    expect(completion.output[0]).toMatchObject({ type: 'provider_opaque', provider: 'grok' });
  });

  it('scopes encrypted reasoning under the grok metadata key', () => {
    const state = createResponseEventNormalizationState();
    const completion: any = normalizeResponseEvent(
      {
        type: 'response.completed',
        response: {
          id: 'resp-2',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'r1',
              summary: [{ type: 'summary_text', text: 'thinking' }],
              encrypted_content: 'XAI-CIPHERTEXT',
            },
          ],
        },
      },
      state,
      GROK_RESPONSES_OPAQUE_TAG,
    );

    expect(completion.output[0].providerMetadata).toEqual({ grok: { encrypted_content: 'XAI-CIPHERTEXT' } });
    expect(completion.output[0].providerMetadata.openai).toBeUndefined();
  });

  it('treats an openai-lane opaque item as foreign to the grok lane', () => {
    const openaiItem = { type: 'provider_opaque', provider: 'openai', item: { type: 'compaction' } };
    expect(isForeignProviderOpaque(openaiItem, GROK_RESPONSES_OPAQUE_TAG)).toBe(true);
  });

  it('keeps the openai lane as the default so existing providers are unchanged', () => {
    const state = createResponseEventNormalizationState();
    const completion: any = normalizeResponseEvent(
      {
        type: 'response.completed',
        response: {
          id: 'resp-3',
          status: 'completed',
          output: [
            { type: 'compaction', id: 'c1' },
            { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'OPENAI-CIPHERTEXT' },
          ],
        },
      },
      state,
    );

    expect(completion.output[0]).toMatchObject({ provider: 'openai' });
    expect(completion.output[1].providerMetadata).toEqual({ openai: { encrypted_content: 'OPENAI-CIPHERTEXT' } });
  });
});
