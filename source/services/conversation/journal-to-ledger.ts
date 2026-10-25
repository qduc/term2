import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import { projectPersistedAssistantItemToProviderHistory } from './conversation-turn-items.js';
import { normalizeRunItems } from './run-item-normalizer.js';
import { pairToolOccurrences, toolOccurrenceKey } from './tool-occurrence.js';

/** Reconstruct authoritative ordered pairs, not a provider-call-ID map. */
export function buildToolLedgerFromAssistantTurnItems(
  items: PersistedAssistantTurnItem[],
  turnId: string,
  startedAt: string,
): SavedToolExecution[] {
  const entries = new Map<string, SavedToolExecution>();
  let reasoning: unknown[] = [];
  for (const item of pairToolOccurrences(items, turnId)) {
    if (item.type === 'reasoning') {
      reasoning.push(projectPersistedAssistantItemToProviderHistory(item));
      continue;
    }
    if (item.type !== 'tool_call' && item.type !== 'tool_result') {
      reasoning = [];
      continue;
    }
    const key = toolOccurrenceKey(item);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        turnId: item.turnId ?? turnId,
        callId: item.callId,
        occurrence: item.occurrence,
        toolName: item.toolName,
        status: 'started',
        startedAt,
        historyItems: [],
      };
      entries.set(key, entry);
    }
    if (item.type === 'tool_call') {
      entry.arguments = item.arguments;
      if (!entry.historyItems?.length)
        entry.historyItems = [...reasoning, projectPersistedAssistantItemToProviderHistory(item)];
    } else {
      entry.status = item.status;
      entry.output = item.output;
      entry.completedAt = startedAt;
      if (!normalizeRunItems(entry.historyItems).some((historyItem) => historyItem.type === 'tool_result'))
        entry.historyItems = [...(entry.historyItems ?? []), projectPersistedAssistantItemToProviderHistory(item)];
    }
    reasoning = [];
  }
  return [...entries.values()];
}

/** Preserve journal turn identity while sharing the authoritative pairing rule. */
export function buildToolLedgerFromJournalEvents(
  events: AssistantJournalItemLogEvent[],
  startedAt: string,
): SavedToolExecution[] {
  const turns = new Map<string, PersistedAssistantTurnItem[]>();
  for (const event of events) {
    const items = turns.get(event.turnId) ?? [];
    items.push(event.item);
    turns.set(event.turnId, items);
  }
  return [...turns].flatMap(([turnId, items]) => buildToolLedgerFromAssistantTurnItems(items, turnId, startedAt));
}
