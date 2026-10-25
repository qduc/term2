import type { Item, ToolCall, ToolResult } from '../../contracts/conversation-items.js';

export type ToolOccurrence = { turnId?: string; occurrence?: number };

/** Provider IDs correlate calls and results; only a turn-local ordinal identifies an admission. */
export const toolOccurrenceKey = (item: ToolOccurrence & { callId: string }): string =>
  JSON.stringify([item.turnId ?? '', item.callId, item.occurrence ?? null]);

export const toolOccurrenceMetadata = (item: ToolOccurrence): ToolOccurrence => ({
  ...(item.turnId ? { turnId: item.turnId } : {}),
  ...(item.occurrence !== undefined ? { occurrence: item.occurrence } : {}),
});

/**
 * Correlate an authoritative ordered item list. Explicit identities win; an
 * untagged call after settlement opens a new occurrence, even for equal bytes.
 * Repeated representations of an open call/result share the explicit identity.
 * Do not use this to infer occurrences from legacy display-only events.
 */
export function pairToolOccurrences(items: readonly Item[], turnId: string): Item[] {
  const counters = new Map<string, number>();
  const current = new Map<string, ToolCall | ToolResult>();
  return items.map((item) => {
    if (item.type !== 'tool_call' && item.type !== 'tool_result') return item;
    const turn = item.turnId ?? turnId;
    const key = JSON.stringify([turn, item.callId]);
    const previous = current.get(key);
    const occurrence =
      item.occurrence ??
      (item.type === 'tool_result' || previous?.type === 'tool_call'
        ? previous?.occurrence ?? (counters.get(key) ?? 0) + 1
        : (counters.get(key) ?? 0) + 1);
    counters.set(key, Math.max(counters.get(key) ?? 0, occurrence));
    const tagged = { ...item, turnId: turn, occurrence };
    current.set(key, tagged);
    return tagged;
  });
}
