/** Native compaction can replace portable history; unlike reasoning, it cannot be silently dropped. */
import type { Item } from './index.js';
import {
  OPENAI_RESPONSES_OPAQUE_TAG,
  isForeignProviderOpaque,
  providerOpaqueSourceOf,
  providerOpaqueTagOf,
} from './providers/provider-opaque-compatibility.js';

/** The same lane/source policy as the legacy input planner, without changing accepted history. */
export function foreignCompactionRefusal(history: readonly Item[], targetProvider: string): string | undefined {
  const lane = targetProvider === 'codex' ? OPENAI_RESPONSES_OPAQUE_TAG : targetProvider;
  for (const item of history) {
    const candidate = item.type === 'provider_input' ? item.input : item;
    const native = candidate.type === 'provider_opaque' ? candidate.item : candidate;
    if (!native || typeof native !== 'object' || !('type' in native) || native.type !== 'compaction') continue;
    if (!isForeignProviderOpaque(candidate, lane, targetProvider)) continue;
    const sourceProvider = providerOpaqueSourceOf(candidate) ?? providerOpaqueTagOf(candidate);
    return (
      `Cannot switch this conversation from ${sourceProvider} to ${targetProvider}: native provider history ` +
      `has no verified portable coverage, so sending it would omit earlier context. Switch back to ${sourceProvider} ` +
      `to continue, or start a fresh conversation on ${targetProvider}.`
    );
  }
  return undefined;
}
