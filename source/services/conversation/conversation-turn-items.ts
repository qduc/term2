import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type {
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
  PersistedReasoningItem,
} from './conversation-persistence-types.js';
import { normalizeRunItem, normalizeRunItems } from './run-item-normalizer.js';

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const serializeToolCallArgumentsForReplay = (value: unknown): unknown => {
  if (typeof value === 'string' || value === undefined) {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
};

const cloneRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(value);
  return record ? clone(record) : undefined;
};

/**
 * Projects one canonical persisted assistant item back to the provider-facing
 * history shape. This is deliberately the sole place that reconciles canonical
 * fields with provider-native spellings retained for replay and journal recovery.
 */
export function projectPersistedAssistantItemToProviderHistory(item: PersistedAssistantTurnItem): ProviderInputItem {
  if (item.type === 'tool_call') {
    const raw = cloneRecord(item.providerItem) ?? {};
    const providerData = stripReasoningFields(cloneRecord(raw.providerData));
    const callId =
      getString(raw.callId) ??
      getString(raw.call_id) ??
      getString(raw.tool_call_id) ??
      getString(raw.toolCallId) ??
      item.callId;
    return {
      ...raw,
      type: getString(raw.type) ?? 'function_call',
      callId,
      name: getString(raw.name) ?? item.toolName,
      arguments: serializeToolCallArgumentsForReplay(raw.arguments ?? raw.args ?? raw.operation ?? item.arguments),
      ...(providerData ? { providerData } : {}),
    };
  }

  if (item.type === 'tool_result') {
    const raw = cloneRecord(item.providerItem) ?? {};
    const providerData = stripReasoningFields(cloneRecord(raw.providerData));
    return {
      ...raw,
      type: getString(raw.type) ?? 'function_call_result',
      callId:
        getString(raw.callId) ??
        getString(raw.call_id) ??
        getString(raw.tool_call_id) ??
        getString(raw.toolCallId) ??
        item.callId,
      name: getString(raw.name) ?? item.toolName,
      output: raw.output ?? raw.result ?? raw.content ?? item.output,
      ...(providerData ? { providerData } : {}),
    };
  }

  if (item.type === 'assistant_text') {
    const providerData = stripReasoningFields(cloneRecord(item.providerMetadata));
    return {
      role: 'assistant',
      type: 'message',
      ...(item.providerItemId ? { id: item.providerItemId } : {}),
      status: 'completed',
      content: [{ type: 'output_text', text: item.text }],
      ...(providerData ? { providerData } : {}),
    };
  }

  const providerData = cloneRecord(item.providerMetadata);
  if (providerData) {
    delete providerData.reasoning_content;
  }
  return {
    type: 'reasoning',
    ...(item.providerItemId ? { id: item.providerItemId } : {}),
    content: item.text ? [{ type: 'reasoning_text', text: item.text }] : [],
    rawContent: item.text ? [{ type: 'reasoning_text', text: item.text }] : [],
    ...(providerData && Object.keys(providerData).length > 0 ? { providerData } : {}),
  };
}

// Reasoning is reconstructed as standalone history items, so any reasoning fields
// that may have been captured on an adjacent tool-call or assistant message's
// providerData must be removed to avoid the reasoning being emitted twice (once on
// the message and once on the standalone item) by the chat-completions converter.
const stripReasoningFields = (
  providerData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!providerData) {
    return undefined;
  }
  const { reasoning: _reasoning, reasoning_content: _rc, reasoning_details: _rd, ...rest } = providerData;
  return Object.keys(rest).length > 0 ? rest : undefined;
};

/**
 * Builds the `providerData` for a reconstructed standalone reasoning item from a
 * run of consecutive persisted reasoning items. The reasoning *text* is carried
 * separately in the item's `content` (see {@link synthesizeHistoryFromAssistantTurn}),
 * so this intentionally omits `reasoning_content` to avoid the text being emitted
 * twice. Signature-bearing fields such as `reasoning_details` are preserved so
 * providers that require them (e.g. OpenRouter) keep working.
 */
const mergeReasoningProviderData = (reasoningItems: PersistedReasoningItem[]): Record<string, unknown> | undefined => {
  const merged: Record<string, unknown> = {};
  const reasoningDetails: unknown[] = [];

  for (const item of reasoningItems) {
    if (!item.providerMetadata) {
      continue;
    }
    for (const [key, value] of Object.entries(item.providerMetadata)) {
      if (key === 'reasoning_content' || key === 'reasoning_details') {
        continue;
      }
      merged[key] = clone(value);
    }
    const metadataDetails = item.providerMetadata.reasoning_details;
    if (Array.isArray(metadataDetails)) {
      reasoningDetails.push(...clone(metadataDetails));
    }
  }

  if (reasoningDetails.length > 0) {
    merged.reasoning_details = reasoningDetails;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * Normalize a single raw provider run item into zero or more persisted item
 * shapes. Returns an empty array if the item is not a recognized
 * assistant-produced shape.
 *
 * The push helpers may produce multiple items (e.g. a reasoning fragment
 * followed by an assistant message or tool call), so callers that need the
 * full set should use this instead of `buildPersistedAssistantItemFromRaw`.
 */
export function buildPersistedAssistantItemsFromRaw(item: unknown): PersistedAssistantTurnItem[] {
  return normalizeRunItem(item);
}

/**
 * Normalize a single raw provider run item into a persisted item shape.
 * Returns `null` if the item is not a recognized assistant-produced shape
 * (tool call, tool result, assistant message, or reasoning).
 *
 * When the raw item maps to multiple persisted items (e.g. reasoning +
 * text), only the first is returned. Prefer `buildPersistedAssistantItemsFromRaw`
 * when you need the full set.
 */
export function buildPersistedAssistantItemFromRaw(item: unknown): PersistedAssistantTurnItem | null {
  return buildPersistedAssistantItemsFromRaw(item)[0] ?? null;
}

export function buildPersistedAssistantTurnItems(items: readonly unknown[] | undefined): PersistedAssistantTurnItem[] {
  return normalizeRunItems(items);
}

export function synthesizeHistoryFromAssistantTurn(
  baseHistory: readonly ProviderInputItem[],
  turn: PersistedAssistantTurn,
): ProviderInputItem[] {
  const history = clone([...baseHistory]);
  const pendingReasoning: PersistedReasoningItem[] = [];

  // Flush buffered reasoning as a standalone history item. The SDK's
  // chat-completions converter reads `content[0].text` and attaches the reasoning
  // to the following assistant/tool-call message at message level. We deliberately
  // do NOT fold the reasoning into the next item's providerData: doing so makes the
  // text serialize onto both the assistant message and the tool call (duplicate
  // reasoning_content).
  const flushPendingReasoning = (): void => {
    if (pendingReasoning.length === 0) {
      return;
    }
    const text = pendingReasoning
      .map((r) => r.text ?? '')
      .filter(Boolean)
      .join('');
    const providerData = mergeReasoningProviderData(pendingReasoning);
    const providerItemId = pendingReasoning.find((r) => r.providerItemId)?.providerItemId;
    pendingReasoning.length = 0;

    if (!text && !providerData) {
      return;
    }

    history.push({
      type: 'reasoning',
      ...(providerItemId ? { id: providerItemId } : {}),
      content: text ? [{ type: 'reasoning_text', text }] : [],
      rawContent: text ? [{ type: 'reasoning_text', text }] : [],
      ...(providerData ? { providerData } : {}),
    });
  };

  for (const item of turn.items) {
    if (item.type === 'reasoning') {
      pendingReasoning.push(item);
      continue;
    }

    flushPendingReasoning();

    if (item.type === 'tool_call') {
      history.push(projectPersistedAssistantItemToProviderHistory(item));
      continue;
    }

    if (item.type === 'tool_result') {
      history.push(projectPersistedAssistantItemToProviderHistory(item));
      continue;
    }

    if (item.type === 'assistant_text') {
      history.push(projectPersistedAssistantItemToProviderHistory(item));
    }
  }

  flushPendingReasoning();

  return history;
}
