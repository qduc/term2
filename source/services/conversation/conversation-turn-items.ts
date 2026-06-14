import type { AgentInputItem } from '@openai/agents';
import type {
  PersistedAssistantTextItem,
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
  PersistedReasoningItem,
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const rawItem = (value: unknown): Record<string, unknown> | null => {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return asRecord(record.rawItem) ?? record;
};

const getString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const extractTextParts = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => {
      const record = asRecord(part);
      const type = getString(record?.type);
      return (type === 'output_text' || type === 'text') && typeof record?.text === 'string';
    })
    .map((part) => String((part as { text: string }).text))
    .join('');
};

// Some providers store reasoning in a `rawContent` array of
// `{ type: 'reasoning_text', text }` parts (rather than in `content`, `text`,
// or `reasoning_content`). Pull text out of those parts.
const extractReasoningParts = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => {
      const record = asRecord(part);
      const type = getString(record?.type);
      return (type === 'reasoning_text' || type === 'reasoning') && typeof record?.text === 'string';
    })
    .map((part) => String((part as { text: string }).text))
    .join('');
};

const cloneRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(value);
  return record ? clone(record) : undefined;
};

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

const getProviderMetadata = (item: unknown): Record<string, unknown> | undefined => {
  const raw = rawItem(item);
  const providerData =
    cloneRecord(raw?.providerData) ?? cloneRecord(raw?.provider_data) ?? cloneRecord(asRecord(item)?.providerData);
  const reasoning = getString(raw?.reasoning) ?? getString(asRecord(item)?.reasoning);
  const reasoningContent =
    getString(raw?.reasoning_content) ??
    getString(asRecord(item)?.reasoning_content) ??
    getString(providerData?.reasoning_content);
  const reasoningDetails =
    raw?.reasoning_details ?? asRecord(item)?.reasoning_details ?? providerData?.reasoning_details;

  const metadata: Record<string, unknown> = providerData ? clone(providerData) : {};
  if (reasoning) {
    metadata.reasoning = reasoning;
  }
  if (reasoningContent) {
    metadata.reasoning_content = reasoningContent;
  }
  if (reasoningDetails != null) {
    metadata.reasoning_details = clone(reasoningDetails);
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const getReasoningText = (item: unknown): string => {
  const raw = rawItem(item);
  if (!raw) {
    return '';
  }

  const direct =
    getString(raw.text) ??
    getString(raw.delta) ??
    getString(raw.summary) ??
    getString(raw.reasoning_content) ??
    getString(asRecord(item)?.reasoning_content);
  if (direct) {
    return direct;
  }

  const metadata = getProviderMetadata(item);
  const fromMetadata = getString(metadata?.reasoning_content);
  if (fromMetadata) {
    return fromMetadata;
  }

  const fromRawContent = extractReasoningParts(raw.rawContent) || extractReasoningParts(asRecord(item)?.rawContent);
  if (fromRawContent) {
    return fromRawContent;
  }

  return extractTextParts(raw.content);
};

const getProviderItemId = (item: unknown): string | undefined => {
  const raw = rawItem(item);
  return getString(raw?.id) ?? getString(asRecord(item)?.id);
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

const makeReasoningItem = (item: unknown): PersistedReasoningItem | null => {
  const text = getReasoningText(item);
  const providerMetadata = getProviderMetadata(item);
  const providerItemId = getProviderItemId(item);
  const raw = rawItem(item);
  const sequence = typeof raw?.index === 'number' ? raw.index : undefined;

  if (!text && !providerMetadata) {
    return null;
  }

  return {
    type: 'reasoning',
    text,
    ...(providerMetadata ? { providerMetadata } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  };
};

const pushAssistantMessageItems = (target: PersistedAssistantTurnItem[], item: unknown): void => {
  const text = extractTextParts(rawItem(item)?.content);
  const providerMetadata = getProviderMetadata(item);
  const providerItemId = getProviderItemId(item);
  const reasoningText = getString(providerMetadata?.reasoning_content);

  if (reasoningText) {
    target.push({
      type: 'reasoning',
      text: reasoningText,
      ...(providerMetadata ? { providerMetadata } : {}),
    });
  }

  if (!text) {
    return;
  }

  const assistantTextItem: PersistedAssistantTextItem = {
    type: 'assistant_text',
    text,
    ...(providerMetadata ? { providerMetadata } : {}),
    ...(providerItemId ? { providerItemId } : {}),
  };
  target.push(assistantTextItem);
};

const pushToolCallItem = (target: PersistedAssistantTurnItem[], item: unknown): void => {
  const raw = rawItem(item);
  if (!raw) {
    return;
  }

  const providerMetadata = getProviderMetadata(item);
  const reasoningText = getString(providerMetadata?.reasoning_content);
  if (reasoningText) {
    target.push({
      type: 'reasoning',
      text: reasoningText,
      ...(providerMetadata ? { providerMetadata } : {}),
    });
  }

  const callId =
    getString(raw.callId) ??
    getString(raw.call_id) ??
    getString(raw.tool_call_id) ??
    getString(raw.id) ??
    'unknown-call';
  const toolName = getString(raw.name) ?? getString(asRecord(item)?.name) ?? 'unknown';

  const toolCallItem: PersistedToolCallItem = {
    type: 'tool_call',
    callId,
    toolName,
    arguments: raw.arguments ?? raw.args ?? asRecord(item)?.arguments ?? asRecord(item)?.args,
    providerItem: clone(raw),
  };
  target.push(toolCallItem);
};

const pushToolResultItem = (target: PersistedAssistantTurnItem[], item: unknown): void => {
  const raw = rawItem(item);
  if (!raw) {
    return;
  }

  const callId =
    getString(raw.callId) ??
    getString(raw.call_id) ??
    getString(raw.tool_call_id) ??
    getString(raw.id) ??
    'unknown-call';
  const toolName = getString(raw.name) ?? getString(asRecord(item)?.name) ?? 'unknown';
  const status = typeof raw.is_error === 'boolean' && raw.is_error ? 'failed' : 'completed';

  const toolResultItem: PersistedToolResultItem = {
    type: 'tool_result',
    callId,
    toolName,
    status,
    output: raw.output ?? asRecord(item)?.output,
    providerItem: clone(raw),
  };
  target.push(toolResultItem);
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
  const raw = rawItem(item);
  if (!raw) {
    return [];
  }

  const role = getString(raw.role);
  const type = getString(raw.type) ?? '';

  if (type === 'reasoning') {
    const reasoningItem = makeReasoningItem(item);
    return reasoningItem ? [reasoningItem] : [];
  }

  if (role === 'assistant' && type === 'message') {
    const target: PersistedAssistantTurnItem[] = [];
    pushAssistantMessageItems(target, item);
    return target;
  }

  if (type === 'function_call' || type === 'apply_patch_call') {
    const target: PersistedAssistantTurnItem[] = [];
    pushToolCallItem(target, item);
    return target;
  }

  if (
    type === 'function_call_result' ||
    type === 'function_call_output' ||
    type === 'function_call_output_result' ||
    type === 'tool_call_output_item' ||
    type === 'apply_patch_call_output'
  ) {
    const target: PersistedAssistantTurnItem[] = [];
    pushToolResultItem(target, item);
    return target;
  }

  return [];
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
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const persisted: PersistedAssistantTurnItem[] = [];
  for (const item of items) {
    const raw = rawItem(item);
    if (!raw) {
      continue;
    }

    const role = getString(raw.role);
    const type = getString(raw.type) ?? '';

    if (type === 'reasoning') {
      const reasoningItem = makeReasoningItem(item);
      if (reasoningItem) {
        persisted.push(reasoningItem);
      }
      continue;
    }

    if (role === 'assistant' && type === 'message') {
      pushAssistantMessageItems(persisted, item);
      continue;
    }

    if (type === 'function_call' || type === 'apply_patch_call') {
      pushToolCallItem(persisted, item);
      continue;
    }

    if (
      type === 'function_call_result' ||
      type === 'function_call_output' ||
      type === 'function_call_output_result' ||
      type === 'tool_call_output_item' ||
      type === 'apply_patch_call_output'
    ) {
      pushToolResultItem(persisted, item);
    }
  }

  return persisted;
}

export function synthesizeHistoryFromAssistantTurn(
  baseHistory: readonly AgentInputItem[],
  turn: PersistedAssistantTurn,
): AgentInputItem[] {
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
    } as unknown as AgentInputItem);
  };

  for (const item of turn.items) {
    if (item.type === 'reasoning') {
      pendingReasoning.push(item);
      continue;
    }

    flushPendingReasoning();

    if (item.type === 'tool_call') {
      const raw = cloneRecord(item.providerItem) ?? {};
      const providerData = stripReasoningFields(cloneRecord(raw.providerData));
      const callId = getString(raw.callId) ?? getString(raw.call_id) ?? getString(raw.tool_call_id) ?? item.callId;
      const toolName = getString(raw.name) ?? item.toolName;
      history.push({
        ...(raw as AgentInputItem),
        type: getString(raw.type) ?? 'function_call',
        ...(getString(raw.id) ? { id: raw.id } : item.providerItem && 'id' in item.providerItem ? {} : {}),
        callId,
        name: toolName,
        arguments: raw.arguments ?? raw.args ?? item.arguments,
        ...(providerData ? { providerData } : {}),
      } as AgentInputItem);
      continue;
    }

    if (item.type === 'tool_result') {
      const raw = cloneRecord(item.providerItem) ?? {};
      history.push({
        ...(raw as AgentInputItem),
        type: getString(raw.type) ?? 'function_call_result',
        callId: getString(raw.callId) ?? getString(raw.call_id) ?? getString(raw.tool_call_id) ?? item.callId,
        name: getString(raw.name) ?? item.toolName,
        output: raw.output ?? item.output,
      } as AgentInputItem);
      continue;
    }

    if (item.type === 'assistant_text') {
      const providerData = stripReasoningFields(cloneRecord(item.providerMetadata));
      history.push({
        role: 'assistant',
        type: 'message',
        ...(item.providerItemId ? { id: item.providerItemId } : {}),
        status: 'completed',
        content: [{ type: 'output_text', text: item.text }],
        ...(providerData ? { providerData } : {}),
      } as AgentInputItem);
    }
  }

  flushPendingReasoning();

  return history;
}
