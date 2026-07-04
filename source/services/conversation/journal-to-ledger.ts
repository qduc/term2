import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { AssistantJournalItemLogEvent } from '../logging/conversation-log-events.js';
import type {
  PersistedAssistantTurnItem,
  PersistedToolCallItem,
  PersistedToolResultItem,
} from './conversation-persistence-types.js';

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

const makeHistoryItemForToolCall = (item: PersistedToolCallItem): unknown => {
  const raw = item.providerItem;
  if (raw && typeof raw === 'object') {
    return clone(raw);
  }
  return {
    type: 'function_call',
    callId: item.callId,
    name: item.toolName,
    arguments: item.arguments,
  };
};

const makeHistoryItemForToolResult = (item: PersistedToolResultItem): unknown => {
  const raw = item.providerItem;
  if (raw && typeof raw === 'object') {
    return clone(raw);
  }
  return {
    type: 'function_call_result',
    callId: item.callId,
    name: item.toolName,
    output: item.output,
  };
};

const makeHistoryItemForReasoning = (item: Extract<PersistedAssistantTurnItem, { type: 'reasoning' }>): unknown => {
  const providerData = item.providerMetadata ? clone(item.providerMetadata) : undefined;
  if (providerData && 'reasoning_content' in providerData) {
    delete providerData.reasoning_content;
  }

  return {
    type: 'reasoning',
    ...(item.providerItemId ? { id: item.providerItemId } : {}),
    content: item.text ? [{ type: 'reasoning_text', text: item.text }] : [],
    rawContent: item.text ? [{ type: 'reasoning_text', text: item.text }] : [],
    ...(providerData && Object.keys(providerData).length > 0 ? { providerData } : {}),
  };
};

const historyItemType = (item: unknown): string => {
  const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  const raw =
    record?.rawItem && typeof record.rawItem === 'object' ? (record.rawItem as Record<string, unknown>) : record;
  return typeof raw?.type === 'string' ? raw.type : '';
};

const withMissingReasoningPrefix = (historyItems: unknown[] | undefined, reasoningItems: unknown[]): unknown[] => {
  const existing = historyItems ?? [];
  if (reasoningItems.length === 0 || existing.some((item) => historyItemType(item) === 'reasoning')) {
    return existing;
  }
  return [...reasoningItems, ...existing];
};

const hasToolResultForCall = (historyItems: readonly unknown[], callId: string): boolean =>
  historyItems.some((item) => {
    const type = historyItemType(item);
    return (
      (type === 'function_call_result' ||
        type === 'function_call_output' ||
        type === 'function_call_output_result' ||
        type === 'tool_call_output_item') &&
      callIdOf(item) === callId
    );
  });

const callIdOf = (item: unknown): string | null => {
  const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  const raw =
    record?.rawItem && typeof record.rawItem === 'object' ? (record.rawItem as Record<string, unknown>) : record;
  const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id ?? raw?.toolCallId ?? raw?.id;
  return typeof callId === 'string' && callId ? callId : null;
};

const appendToolResultIfMissing = (
  historyItems: unknown[] | undefined,
  callId: string,
  resultItem: unknown,
): unknown[] => {
  const existing = historyItems ?? [];
  return hasToolResultForCall(existing, callId) ? existing : [...existing, resultItem];
};

/**
 * Reconstructs tool-execution ledger entries from persisted assistant turn
 * items. This lets the durable journal serve as the source of truth for
 * recovery instead of the legacy in-memory ledger.
 */
export function buildToolLedgerFromAssistantTurnItems(
  items: PersistedAssistantTurnItem[],
  turnId: string,
  startedAt: string,
): SavedToolExecution[] {
  const entries: SavedToolExecution[] = [];
  const calls = new Map<string, PersistedToolCallItem>();
  let pendingReasoningHistoryItems: unknown[] = [];

  for (const item of items) {
    if (item.type === 'reasoning') {
      pendingReasoningHistoryItems.push(makeHistoryItemForReasoning(item));
      continue;
    }

    if (item.type === 'tool_call') {
      calls.set(item.callId, item);
      const callHistoryItem = makeHistoryItemForToolCall(item);
      const existing = entries.find((entry) => entry.callId === item.callId);
      if (!existing) {
        entries.push({
          turnId,
          callId: item.callId,
          toolName: item.toolName,
          arguments: item.arguments,
          status: 'started',
          startedAt,
          historyItems: [...pendingReasoningHistoryItems, callHistoryItem].filter(Boolean) as unknown[],
        });
      } else {
        existing.toolName = item.toolName;
        existing.arguments = item.arguments;
        if (!existing.historyItems || existing.historyItems.length === 0) {
          existing.historyItems = [...pendingReasoningHistoryItems, callHistoryItem].filter(Boolean) as unknown[];
        } else {
          existing.historyItems = withMissingReasoningPrefix(existing.historyItems, pendingReasoningHistoryItems);
        }
      }
      pendingReasoningHistoryItems = [];
      continue;
    }

    pendingReasoningHistoryItems = [];

    if (item.type !== 'tool_result') {
      continue;
    }

    let existing = entries.find((entry) => entry.callId === item.callId);
    if (!existing) {
      const call = calls.get(item.callId);
      existing = {
        turnId,
        callId: item.callId,
        toolName: item.toolName,
        arguments: call?.arguments,
        status: 'started',
        startedAt,
        historyItems: call ? [makeHistoryItemForToolCall(call)] : [],
      };
      entries.push(existing);
    }

    const callHistoryItem = existing.historyItems?.find((historyItem) => {
      const record = historyItem && typeof historyItem === 'object' ? (historyItem as Record<string, unknown>) : null;
      return record?.type === 'function_call';
    });
    existing.toolName = item.toolName;
    existing.status = item.status;
    existing.output = item.output;
    existing.completedAt = startedAt;
    const previousHistoryItems = existing.historyItems ?? (callHistoryItem ? [callHistoryItem] : []);
    existing.historyItems = appendToolResultIfMissing(
      previousHistoryItems,
      item.callId,
      makeHistoryItemForToolResult(item),
    ).filter(Boolean) as unknown[];
  }

  return entries;
}

/**
 * Reconstructs tool-execution ledger entries from journal item events,
 * preserving the original turn ids. Prefer this over
 * {@link buildToolLedgerFromAssistantTurnItems} when recovering from the
 * live journal so multi-turn history stays correctly ordered.
 */
export function buildToolLedgerFromJournalEvents(
  events: AssistantJournalItemLogEvent[],
  startedAt: string,
): SavedToolExecution[] {
  const entriesByTurn = new Map<string, SavedToolExecution[]>();
  const pendingReasoningByTurn = new Map<string, unknown[]>();

  for (const event of events) {
    const turnEntries = entriesByTurn.get(event.turnId) ?? [];
    entriesByTurn.set(event.turnId, turnEntries);
    const pendingReasoning = pendingReasoningByTurn.get(event.turnId) ?? [];
    pendingReasoningByTurn.set(event.turnId, pendingReasoning);

    const item = event.item;
    if (item.type === 'reasoning') {
      pendingReasoning.push(makeHistoryItemForReasoning(item));
      continue;
    }

    if (item.type === 'tool_call') {
      const existing = turnEntries.find((entry) => entry.callId === item.callId);
      const callHistoryItem = makeHistoryItemForToolCall(item);
      if (!existing) {
        turnEntries.push({
          turnId: event.turnId,
          callId: item.callId,
          toolName: item.toolName,
          arguments: item.arguments,
          status: 'started',
          startedAt,
          historyItems: [...pendingReasoning, callHistoryItem].filter(Boolean) as unknown[],
        });
      } else {
        existing.toolName = item.toolName;
        existing.arguments = item.arguments;
        if (!existing.historyItems || existing.historyItems.length === 0) {
          existing.historyItems = [...pendingReasoning, callHistoryItem].filter(Boolean) as unknown[];
        } else {
          existing.historyItems = withMissingReasoningPrefix(existing.historyItems, pendingReasoning);
        }
      }
      pendingReasoning.length = 0;
      continue;
    }

    pendingReasoning.length = 0;

    if (item.type === 'tool_result') {
      let existing = turnEntries.find((entry) => entry.callId === item.callId);
      if (!existing) {
        existing = {
          turnId: event.turnId,
          callId: item.callId,
          toolName: item.toolName,
          arguments: undefined,
          status: 'started',
          startedAt,
          historyItems: [],
        };
        turnEntries.push(existing);
      }
      existing.toolName = item.toolName;
      existing.status = item.status;
      existing.output = item.output;
      existing.completedAt = startedAt;
      const previousHistoryItems = existing.historyItems ?? [];
      existing.historyItems = appendToolResultIfMissing(
        previousHistoryItems,
        item.callId,
        makeHistoryItemForToolResult(item),
      ).filter(Boolean) as unknown[];
    }
  }

  return [...entriesByTurn.values()].flat();
}
