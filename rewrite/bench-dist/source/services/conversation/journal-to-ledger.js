import { projectPersistedAssistantItemToProviderHistory } from './conversation-turn-items.js';
import { normalizeRunItems } from './run-item-normalizer.js';
import { pairToolOccurrences, toolOccurrenceKey } from './tool-occurrence.js';
/** Reconstruct authoritative ordered pairs, not a provider-call-ID map. */
export function buildToolLedgerFromAssistantTurnItems(items, turnId, startedAt) {
    const entries = new Map();
    let reasoning = [];
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
        }
        else {
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
export function buildToolLedgerFromJournalEvents(events, startedAt) {
    const turns = new Map();
    for (const event of events) {
        const items = turns.get(event.turnId) ?? [];
        items.push(event.item);
        turns.set(event.turnId, items);
    }
    return [...turns].flatMap(([turnId, items]) => buildToolLedgerFromAssistantTurnItems(items, turnId, startedAt));
}
//# sourceMappingURL=journal-to-ledger.js.map