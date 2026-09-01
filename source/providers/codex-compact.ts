import type { ProviderInputItem } from '../contracts/provider-input.js';
import { OPENAI_RESPONSES_OPAQUE_TAG } from './provider-opaque-compatibility.js';

/**
 * Codex (chatgpt.com) does not accept Responses `context_management` on ordinary
 * turns. Compaction uses the Responses endpoint with a trailing
 * `{ type: 'compaction_trigger' }`, which returns one opaque
 * `{ type: 'compaction' }` output item. Pass that artifact through as the next
 * request's history.
 */
export function compactOutputToProviderHistory(output: readonly unknown[]): ProviderInputItem[] {
  return output.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Codex compact output contained a non-object item');
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'compaction') {
      return {
        ...record,
        providerOpaque: { provider: OPENAI_RESPONSES_OPAQUE_TAG },
      };
    }
    return record as ProviderInputItem;
  });
}
