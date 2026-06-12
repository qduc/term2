import {
  getCallIdFromItem,
  normalizeToolArguments,
  getOutputText,
  type ToolResultItem,
} from '../../tools/format-helpers.js';
import { getToolFormatter } from '../../tools/command-message-formatters.js';
import type { CommandMessage } from '../../tools/types.js';

const approvalRejectionCallIds = new Set<string>();

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

const normalizeToolItem = (
  item: ToolResultItem | null | undefined,
): { toolName: string; arguments: unknown; outputText: string } | null => {
  if (!item) {
    return null;
  }

  const rawItem = item.rawItem ?? item;
  const type = item.type ?? rawItem?.type;
  const isFunctionResult =
    type === 'function_call_result' ||
    rawItem?.type === 'function_call_result' ||
    type === 'function_call_output' ||
    rawItem?.type === 'function_call_output' ||
    type === 'function_call_output_result' ||
    rawItem?.type === 'function_call_output_result' ||
    type === 'apply_patch_call_output' ||
    rawItem?.type === 'apply_patch_call_output';
  const isToolCallOutput = type === 'tool_call_output_item';

  if (!isFunctionResult && !isToolCallOutput) {
    return null;
  }

  const toolName =
    rawItem?.name ??
    item.name ??
    (type === 'apply_patch_call_output' || rawItem?.type === 'apply_patch_call_output' ? 'apply_patch' : undefined);
  if (!toolName) {
    return null;
  }

  return {
    toolName,
    arguments: rawItem?.arguments ?? item.arguments,
    outputText: getOutputText(item),
  };
};

export const extractCommandMessages = (items: readonly unknown[] = []): CommandMessage[] => {
  const messages: CommandMessage[] = [];
  const toolCallArgumentsById = new Map<string, unknown>();

  for (const rawItem of items ?? []) {
    const item = rawItem as ToolResultItem | null | undefined;
    const innerRaw = item?.rawItem ?? item;
    if (!rawItem) {
      continue;
    }

    const type = innerRaw?.type ?? item?.type;
    if (type !== 'function_call' && type !== 'apply_patch_call') {
      continue;
    }

    const callId = getCallIdFromItem(innerRaw) ?? getCallIdFromItem(item);
    if (!callId) {
      continue;
    }

    const args =
      innerRaw?.arguments ?? innerRaw?.args ?? innerRaw?.operation ?? item?.arguments ?? item?.args ?? item?.operation;
    if (!args) {
      continue;
    }

    toolCallArgumentsById.set(callId, args);
  }

  for (const [index, rawItem] of (items ?? []).entries()) {
    const item = rawItem as ToolResultItem | null | undefined;
    const normalizedItem = normalizeToolItem(item);
    if (!normalizedItem) {
      continue;
    }

    const isApprovalRejection = isApprovalRejectionForItem(item);

    const formatter = getToolFormatter(normalizedItem.toolName);
    if (formatter) {
      const results = formatter(item as ToolResultItem, index, toolCallArgumentsById);
      if (isApprovalRejection) {
        results.forEach((msg: CommandMessage) => {
          msg.isApprovalRejection = true;
        });
      }
      messages.push(...results);
      continue;
    }

    // Generic fallback for any other tools
    const rawInner = item?.rawItem ?? item;
    const callId = getCallIdFromItem(item);
    const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
    const args = normalizeToolArguments(normalizedItem.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};

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

    const baseId = rawInner?.id ?? rawInner?.callId ?? item?.id ?? item?.callId ?? `${Date.now()}-${index}`;
    const stableId = `${baseId}-0`;

    messages.push({
      id: stableId,
      sender: 'command',
      status: 'completed',
      command,
      output,
      success,
      isApprovalRejection,
      toolName: normalizedItem.toolName,
      toolArgs: args,
      ...(callId ? { callId } : {}),
    });
  }

  return messages;
};
