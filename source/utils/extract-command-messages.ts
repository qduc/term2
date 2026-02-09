import { getCallIdFromItem, normalizeToolArguments, getOutputText } from '../tools/format-helpers.js';
import type { CommandMessage } from '../tools/types.js';
import { formatShellCommandMessage } from '../tools/shell.js';
import { formatGrepCommandMessage } from '../tools/grep.js';
import { formatApplyPatchCommandMessage } from '../tools/apply-patch.js';
import { formatSearchReplaceCommandMessage } from '../tools/search-replace.js';
import { formatAskMentorCommandMessage } from '../tools/ask-mentor.js';
import { formatReadFileCommandMessage } from '../tools/read-file.js';
import { formatFindFilesCommandMessage } from '../tools/find-files.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../tools/tool-names.js';

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

const isApprovalRejectionForItem = (item: any): boolean => {
  const callId = getCallIdFromItem(item);
  if (!callId) {
    return false;
  }
  return approvalRejectionCallIds.has(callId);
};

const normalizeToolItem = (item: any): { toolName: string; arguments: any; outputText: string } | null => {
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
    rawItem?.type === 'function_call_output_result';
  const isToolCallOutput = type === 'tool_call_output_item';

  if (!isFunctionResult && !isToolCallOutput) {
    return null;
  }

  const toolName = rawItem?.name ?? item.name;
  if (!toolName) {
    return null;
  }

  return {
    toolName,
    arguments: rawItem?.arguments ?? item.arguments,
    outputText: getOutputText(item),
  };
};

const toolFormatters: Record<string, Function> = {
  shell: formatShellCommandMessage,
  grep: formatGrepCommandMessage,
  [TOOL_NAME_APPLY_PATCH]: formatApplyPatchCommandMessage,
  read_file: formatReadFileCommandMessage,
  find_files: formatFindFilesCommandMessage,
  [TOOL_NAME_SEARCH_REPLACE]: formatSearchReplaceCommandMessage,
  ask_mentor: formatAskMentorCommandMessage,
};

export const extractCommandMessages = (items: any[] = []): CommandMessage[] => {
  const messages: CommandMessage[] = [];
  const toolCallArgumentsById = new Map<string, unknown>();

  for (const item of items ?? []) {
    const rawItem = item?.rawItem ?? item;
    if (!rawItem) {
      continue;
    }

    const type = rawItem?.type ?? item?.type;
    if (type !== 'function_call') {
      continue;
    }

    const callId = getCallIdFromItem(rawItem) ?? getCallIdFromItem(item);
    if (!callId) {
      continue;
    }

    const args = rawItem.arguments ?? rawItem.args ?? item?.arguments ?? item?.args;
    if (!args) {
      continue;
    }

    toolCallArgumentsById.set(callId, args);
  }

  for (const [index, item] of (items ?? []).entries()) {
    const normalizedItem = normalizeToolItem(item);
    if (!normalizedItem) {
      continue;
    }

    const isApprovalRejection = isApprovalRejectionForItem(item);

    const formatter = toolFormatters[normalizedItem.toolName];
    if (formatter) {
      const results = formatter(item, index, toolCallArgumentsById);
      if (isApprovalRejection) {
        results.forEach((msg: CommandMessage) => {
          msg.isApprovalRejection = true;
        });
      }
      messages.push(...results);
      continue;
    }

    // Generic fallback for any other tools
    const rawItem = item?.rawItem ?? item;
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

    const baseId = rawItem?.id ?? rawItem?.callId ?? item?.id ?? item?.callId ?? `${Date.now()}-${index}`;
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
