import type { CommandMessage } from '../tools/types.js';
import type { ConversationEvent } from './conversation-events.js';
import { extractCommandMessages } from '../utils/extract-command-messages.js';

type ExtractCommandMessages = (items: any[]) => CommandMessage[];

export const captureToolCallArguments = (item: any, toolCallArgumentsById: Map<string, unknown>): void => {
  const rawItem = item?.rawItem ?? item;
  if (!rawItem) {
    return;
  }

  if (rawItem?.type !== 'function_call') {
    return;
  }

  const callId = rawItem.callId ?? rawItem.call_id ?? rawItem.tool_call_id ?? rawItem.toolCallId ?? rawItem.id;
  if (!callId) {
    return;
  }

  const args = rawItem.arguments ?? rawItem.args ?? item?.arguments ?? item?.args;
  if (!args) {
    return;
  }

  toolCallArgumentsById.set(callId, args);
};

export const attachCachedArguments = (items: any[] = [], toolCallArgumentsById: Map<string, unknown>): void => {
  if (!items?.length) {
    return;
  }

  for (const item of items) {
    if (!item) {
      continue;
    }

    if (item.arguments || item.args || item?.rawItem?.arguments || item?.rawItem?.args) {
      continue;
    }

    const rawItem = item?.rawItem ?? item;
    const callId =
      rawItem?.callId ??
      rawItem?.call_id ??
      rawItem?.tool_call_id ??
      rawItem?.toolCallId ??
      rawItem?.id ??
      item?.callId ??
      item?.call_id ??
      item?.tool_call_id ??
      item?.toolCallId ??
      item?.id;
    if (!callId) {
      continue;
    }

    const args = toolCallArgumentsById.get(callId);
    if (!args) {
      continue;
    }

    item.arguments = args;
  }
};

export const emitCommandMessagesFromItems = (
  items: any[],
  {
    toolCallArgumentsById,
    emittedCommandIds,
    extractCommandMessages: extractCommandMessagesFn = extractCommandMessages,
  }: {
    toolCallArgumentsById: Map<string, unknown>;
    emittedCommandIds: Set<string>;
    extractCommandMessages?: ExtractCommandMessages;
  },
): ConversationEvent[] => {
  attachCachedArguments(items, toolCallArgumentsById);
  const commandMessages = extractCommandMessagesFn(items);
  const out: ConversationEvent[] = [];

  for (const cmdMsg of commandMessages) {
    if (emittedCommandIds.has(cmdMsg.id)) {
      continue;
    }
    if (cmdMsg.isApprovalRejection) {
      continue;
    }
    emittedCommandIds.add(cmdMsg.id);
    out.push({ type: 'command_message', message: cmdMsg });
  }
  return out;
};
