import { isLocalContextSummary, type ProviderInputItem } from '../shared/contracts/provider-input.js';

/** Provider-history projection only: replacement boundaries never consult durable session state. */
const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

export const isOpenAICompaction = (item: unknown): boolean => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (record.type === 'provider_opaque' && record.provider === 'openai') {
    const payload = record.item as Record<string, unknown> | undefined;
    return payload?.type === 'compaction';
  }
  const marker = record.providerOpaque;
  return (
    record.type === 'compaction' &&
    !!marker &&
    typeof marker === 'object' &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>).provider === 'openai'
  );
};

const isContextReplacementBoundary = (item: unknown): boolean =>
  isOpenAICompaction(item) || isLocalContextSummary(item);

export const lastReplacementBoundaryIndex = (history: readonly unknown[]): number => {
  for (let index = history.length - 1; index >= 0; index--) {
    if (isContextReplacementBoundary(history[index])) return index;
  }
  return -1;
};

/**
 * Lossy projection used only when constructing a model request. Durable
 * snapshots/imports retain genuine pre-boundary user turns for navigation.
 */
export function projectModelRequestHistory(history: readonly unknown[]): ProviderInputItem[] {
  const boundary = lastReplacementBoundaryIndex(history);
  return clone((boundary < 0 ? [...history] : history.slice(boundary)) as ProviderInputItem[]);
}
