/**
 * Helper utilities for formatting tool execution results into command messages.
 * These utilities are shared across tool formatters to maintain consistency.
 */

import type { CommandMessage } from './types.js';

/**
 * Structural type for items passed to tool formatters.
 *
 * Items come from two sources:
 *  - SDK `RunItem` subclasses (e.g. `RunToolCallItem`, `RunToolCallOutputItem`) which wrap
 *    a protocol-level item under `.rawItem` and expose camelCase fields on the outer object.
 *  - Raw OpenAI API response items which use snake_case fields (`call_id`, `tool_call_id`).
 *
 * Rather than importing the full SDK discriminated union (which would couple this utility
 * layer to every provider variant), we model the *intersection* of fields that format
 * helpers actually access.  Anything beyond these fields is invisible to this code.
 */
export interface ToolResultItem {
  /** SDK wrapper exposes the raw protocol item; raw API items set this to themselves. */
  rawItem?: ToolResultItem;
  /** Discriminator: function_call, function_call_output, apply_patch_call, etc. */
  type?: string;
  /** Item status: in_progress, completed, incomplete, failed. */
  status?: string;
  /** Camel-case call ID (SDK protocol items). */
  callId?: string;
  /** Snake-case call ID (raw OpenAI API items). */
  call_id?: string;
  /** Legacy / alternate call ID used by some API shapes. */
  tool_call_id?: string;
  /** Another camel-case variant seen on some items. */
  toolCallId?: string;
  /** Generic unique ID fallback. */
  id?: string;
  /** Tool name (on function_call / function_call_output items). */
  name?: string;
  /** Tool call arguments (string or parsed object). */
  arguments?: unknown;
  /** Alternate key for arguments used by some shapes. */
  args?: unknown;
  /** apply_patch_call uses `operation` instead of `arguments`. */
  operation?: { type?: string; path?: string; diff?: string; [key: string]: unknown };
  /** Tool output container (on function_call_output items). */
  output?: { text?: unknown } | string;
}

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
export const getCallIdFromItem = (item: ToolResultItem | null | undefined): string | null => {
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
export const getOutputText = (item: ToolResultItem | null | undefined): string => {
  const sources: Array<ToolResultItem | null | undefined> = [item, item?.rawItem];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const candidate of [
      source.output,
      typeof source.output === 'object' && source.output ? source.output.text : undefined,
    ]) {
      const text = coerceToText(candidate);
      if (text) {
        return text;
      }
    }
  }

  return '';
};

/**
 * Safely parses a JSON string.  Returns `undefined` for non-string,
 * empty, or invalid payloads.
 *
 * Returns `any` because the parsed shape is only known to the caller.
 * The *input* parameter is `unknown`, so untyped data cannot accidentally
 * flow in — the `any` only escapes on the return path where the caller
 * narrows with type guards or `as` assertions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const safeJsonParse = (payload: unknown): any => {
  if (typeof payload !== 'string') {
    return undefined;
  }

  const trimmed = payload.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

/**
 * Normalizes tool arguments from various formats.
 *
 * Returns `any` because the output is consumed by per-tool formatters that
 * know their own argument schema and access specific properties by name.
 * The input parameter is typed `unknown` — the `any` only escapes on the
 * return path, which is the narrowest possible `any` surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const normalizeToolArguments = (value: unknown): any => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return value;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value;
  }

  return null;
};

/**
 * Picks the most informative display string from a single patch-style result item
 * (`apply_patch` / `search_replace`). Order: explicit error → success message →
 * file path. Returns an empty string when none of those fields are present so
 * callers can filter it out.
 */
export const pickPatchOutputItemText = (item: unknown): string => {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error) return record.error;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.path === 'string' && record.path) return record.path;
  return '';
};

/**
 * Joins the per-operation text from an array of patch-style result items
 * (`apply_patch` / `search_replace`) using newlines. Used by live tool
 * formatters and by the conversation replay path so the two stay in sync.
 */
export const formatPatchOutputItems = (items: unknown): string => {
  if (!Array.isArray(items) || items.length === 0) return '';
  const parts: string[] = [];
  for (const item of items) {
    const text = pickPatchOutputItemText(item);
    if (text) parts.push(text);
  }
  return parts.join('\n');
};

/**
 * Generates a stable ID for a command message.
 */
export const generateMessageId = (
  item: ToolResultItem | null | undefined,
  index: number,
  subIndex: number = 0,
): string => {
  const rawItem = item?.rawItem ?? item;
  const baseId = rawItem?.id ?? rawItem?.callId ?? item?.id ?? item?.callId ?? `${Date.now()}-${index}`;
  return `${baseId}-${subIndex}`;
};

/**
 * Creates a base command message with common fields filled in.
 */
export const createBaseMessage = (
  item: ToolResultItem | null | undefined,
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
