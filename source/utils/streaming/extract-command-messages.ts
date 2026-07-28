import {
  getCallIdFromItem,
  normalizeToolArguments,
  getOutputText,
  type ToolResultItem,
} from '../../tools/format-helpers.js';
import { getToolFormatter } from '../../tools/command-message-formatters.js';
import type { CommandMessage } from '../../tools/types.js';
import type { Item, ToolResult } from '../../contracts/conversation-items.js';
import { normalizeRunItem } from '../../services/conversation/run-item-normalizer.js';

const approvalRejectionCallIds = new Set<string>();
const llmAutoApprovalCallIds = new Set<string>();

export const markToolCallAsLlmAutoApproved = (callId?: string | null): void => {
  if (callId) {
    llmAutoApprovalCallIds.add(callId);
  }
};

export const clearLlmAutoApprovalMarkers = (): void => {
  llmAutoApprovalCallIds.clear();
};

export const markToolCallAsApprovalRejection = (callId?: string | null): void => {
  if (!callId) {
    return;
  }
  approvalRejectionCallIds.add(callId);
};

export const clearApprovalRejectionMarkers = (): void => {
  approvalRejectionCallIds.clear();
};

const isApprovalRejectionForItem = (item: ToolResultItem | null | undefined): boolean => {
  const callId = getCallIdFromItem(item);
  if (!callId) {
    return false;
  }
  return approvalRejectionCallIds.has(callId);
};

const consumeLlmAutoApprovalForItem = (item: ToolResultItem | null | undefined): boolean => {
  const callId = getCallIdFromItem(item);
  if (!callId || !llmAutoApprovalCallIds.has(callId)) {
    return false;
  }
  llmAutoApprovalCallIds.delete(callId);
  return true;
};

const normalizeToolItem = (item: Item): { toolName: string; arguments: unknown; outputText: string } | null => {
  if (item.type !== 'tool_result') {
    return null;
  }

  return {
    toolName: item.toolName,
    arguments: undefined,
    outputText: getOutputText(item),
  };
};

const getProviderArguments = (item: ToolResult): unknown => {
  const providerItem = item.providerItem;
  return providerItem?.arguments ?? providerItem?.args ?? providerItem?.operation;
};

export const extractCommandMessages = (items: readonly unknown[] = []): CommandMessage[] => {
  const messages: CommandMessage[] = [];
  const toolCallArgumentsById = new Map<string, unknown>();
  const normalizedItems = items.flatMap(normalizeRunItem);

  for (const item of normalizedItems) {
    if (item.type === 'tool_call' && item.arguments) toolCallArgumentsById.set(item.callId, item.arguments);
  }

  for (const [index, item] of normalizedItems.entries()) {
    const normalizedItem = normalizeToolItem(item);
    if (!normalizedItem) {
      continue;
    }

    const resultItem = item as ToolResult & { arguments?: unknown };

    const isApprovalRejection = isApprovalRejectionForItem(resultItem);
    const autoApprovedByLlm = consumeLlmAutoApprovalForItem(resultItem);

    const formatter = getToolFormatter(normalizedItem.toolName);
    if (formatter) {
      const argumentsForCall = toolCallArgumentsById.get(resultItem.callId) ?? getProviderArguments(resultItem);
      const enrichedItem = {
        ...resultItem,
        ...(argumentsForCall ? { arguments: argumentsForCall } : {}),
      };
      const results = formatter(enrichedItem, index, toolCallArgumentsById);
      results.forEach((msg: CommandMessage) => {
        if (isApprovalRejection) {
          msg.isApprovalRejection = true;
        }
        if (autoApprovedByLlm) {
          msg.autoApprovedByLlm = true;
        }
      });
      messages.push(...results);
      continue;
    }

    // Generic fallback for any other tools
    const callId = getCallIdFromItem(resultItem);
    const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
    const args =
      normalizeToolArguments(resultItem.arguments) ??
      normalizeToolArguments(fallbackArgs) ??
      normalizeToolArguments(getProviderArguments(resultItem)) ??
      {};

    let command = normalizedItem.toolName;
    if (typeof args === 'string') {
      command += ` ${args}`;
    } else if (typeof args === 'object' && args !== null) {
      const parts = Object.values(args).map((v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v)));
      if (parts.length > 0) {
        command += ` ${parts.join(' ')}`;
      }
    }

    const output = normalizedItem.outputText || 'No output';
    const success = !output.startsWith('Error:');

    const providerItem = resultItem.providerItem as ToolResultItem | undefined;
    const baseId = providerItem?.id ?? providerItem?.callId ?? resultItem.callId ?? `${Date.now()}-${index}`;
    const stableId = `${baseId}-0`;

    messages.push({
      id: stableId,
      sender: 'command',
      status: 'completed',
      command,
      output,
      success,
      isApprovalRejection,
      ...(autoApprovedByLlm ? { autoApprovedByLlm: true } : {}),
      toolName: normalizedItem.toolName,
      toolArgs: args,
      ...(callId ? { callId } : {}),
    });
  }

  return messages;
};
