import type { CommandMessage } from '../tools/types.js';
import type { Item, ToolResult } from '../contracts/conversation-items.js';
import type { ConversationEvent } from './conversation/conversation-events.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';
import { extractCommandMessages, type ToolCallMarkerStore } from '../utils/streaming/extract-command-messages.js';

type ExtractCommandMessages = (items: readonly unknown[], markerStore?: ToolCallMarkerStore) => CommandMessage[];
type EnrichedToolResult = ToolResult & { arguments?: unknown };

const normalizedItems = (item: unknown): Item[] => normalizeRunItem(item);

export const captureToolCallArguments = (item: unknown, toolCallArgumentsById: Map<string, unknown>): void => {
  for (const normalized of normalizedItems(item)) {
    if (normalized.type !== 'tool_call' || !normalized.arguments) continue;
    toolCallArgumentsById.set(normalized.callId, normalized.arguments);
  }
};

export const attachCachedArguments = (
  items: readonly unknown[] = [],
  toolCallArgumentsById: Map<string, unknown>,
): EnrichedToolResult[] => {
  return items.flatMap(normalizedItems).flatMap((item) => {
    if (item.type !== 'tool_result') return [];
    const argumentsForCall = toolCallArgumentsById.get(item.callId);
    return [{ ...item, ...(argumentsForCall ? { arguments: argumentsForCall } : {}) }];
  });
};

export const emitCommandMessagesFromItems = (
  items: readonly unknown[],
  {
    toolCallArgumentsById,
    emittedCommandIds,
    extractCommandMessages: extractCommandMessagesFn = extractCommandMessages,
    markerStore,
  }: {
    toolCallArgumentsById: Map<string, unknown>;
    emittedCommandIds: Set<string>;
    extractCommandMessages?: ExtractCommandMessages;
    markerStore?: ToolCallMarkerStore;
  },
): ConversationEvent[] => {
  const commandMessages = extractCommandMessagesFn(attachCachedArguments(items, toolCallArgumentsById), markerStore);
  const out: ConversationEvent[] = [];

  for (const cmdMsg of commandMessages) {
    if (emittedCommandIds.has(cmdMsg.id)) {
      continue;
    }
    emittedCommandIds.add(cmdMsg.id);
    out.push({ type: 'command_message', message: cmdMsg });
  }
  return out;
};
