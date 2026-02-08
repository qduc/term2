/**
 * Helper utilities for formatting tool execution results into command messages.
 * These utilities are shared across tool formatters to maintain consistency.
 */

import type { CommandMessage } from './types.js';

/**
 * Coerces various value types into a text string representation.
 */
export const coerceToText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => coerceToText(part))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }

    if ('output' in value && typeof value.output === 'string') {
      return value.output;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  return String(value);
};

/**
 * Extracts call ID from various item formats.
 */
export const getCallIdFromItem = (item: any): string | null => {
  const rawItem = item?.rawItem ?? item;
  if (!rawItem) {
    return null;
  }

  return (
    rawItem.callId ??
    rawItem.call_id ??
    rawItem.tool_call_id ??
    rawItem.toolCallId ??
    rawItem.id ??
    item?.callId ??
    item?.call_id ??
    item?.tool_call_id ??
    item?.toolCallId ??
    item?.id ??
    null
  );
};

/**
 * Extracts output text from various item formats.
 */
export const getOutputText = (item: any): string => {
  const sources = [item, item?.rawItem];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const candidate of [source.output, source.output?.text]) {
      const text = coerceToText(candidate);
      if (text) {
        return text;
      }
    }
  }

  return '';
};

/**
 * Safely parses JSON payload.
 */
export const safeJsonParse = (payload: unknown): any => {
  if (typeof payload !== 'string') {
    return null;
  }

  const trimmed = payload.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

/**
 * Normalizes tool arguments from various formats.
 */
export const normalizeToolArguments = (value: unknown): any => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return safeJsonParse(value) ?? value;
  }

  return value;
};

/**
 * Generates a stable ID for a command message.
 */
export const generateMessageId = (item: any, index: number, subIndex: number = 0): string => {
  const rawItem = item?.rawItem ?? item;
  const baseId = rawItem?.id ?? rawItem?.callId ?? item?.id ?? item?.callId ?? `${Date.now()}-${index}`;
  return `${baseId}-${subIndex}`;
};

/**
 * Creates a base command message with common fields filled in.
 */
export const createBaseMessage = (
  item: any,
  index: number,
  subIndex: number,
  isApprovalRejection: boolean,
  partial: Partial<CommandMessage>,
): CommandMessage => {
  const callId = getCallIdFromItem(item);
  return {
    id: generateMessageId(item, index, subIndex),
    sender: 'command',
    status: 'completed',
    isApprovalRejection,
    ...(callId ? { callId } : {}),
    ...partial,
  } as CommandMessage;
};
