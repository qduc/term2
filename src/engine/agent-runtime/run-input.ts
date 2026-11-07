import { z } from 'zod';
import type { ProviderInput, ProviderInputItem } from '../../shared/contracts/provider-input.js';
import type {
  StreamedModelMessagePart,
  StreamedModelProviderOptions,
  StreamedModelToolDefinition,
  StreamedModelToolResultPart,
  StreamedModelTurnInput,
} from '../../model/streamed-model-turn.js';
import { formatConversationTimeGap } from '../../shared/conversation/conversation-time-gap.js';
import { personalMemoryNotice } from '../../shared/conversation/personal-memory-context.js';
import type { ToolRegistry } from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
/** The provider-facing tool catalog, shared by normal and prefix-preserving summary requests. */
export function toModelTools(tools: ToolRegistry): StreamedModelToolDefinition[] {
  return tools.map((tool) =>
    tool.modelTool
      ? {
          type: tool.modelTool.type,
          name: tool.name,
          description: tool.description,
          format: tool.modelTool.format,
        }
      : {
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: isJsonSchema(tool.parameters) ? tool.parameters : z.toJSONSchema(tool.parameters),
        },
  );
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isZodToolParameterSchema(value);
}

/**
 * The canonical application projection used for both model requests and
 * continuation-prefix comparisons. Keep this at the application boundary so
 * callers never need to inspect opaque continuation state.
 */
export function normalizeApplicationInput(
  input: ProviderInput | readonly ProviderInputItem[],
): StreamedModelTurnInput[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  const items = (Array.isArray(input) ? input : [input]) as readonly ProviderInputItem[];
  return items.flatMap((item) => {
    const notice = item.role === 'user' ? formatConversationTimeGap(item.conversationTimeGap) : null;
    return [
      ...(item.role === 'user' && typeof item.personalMemoryContext === 'string'
        ? normalizeInputItem({
            type: 'message',
            role: 'user',
            content: personalMemoryNotice(item.personalMemoryContext),
          })
        : []),
      ...(notice ? normalizeInputItem({ type: 'message', role: 'system', content: notice }) : []),
      ...normalizeInputItem(item),
    ];
  });
}

export function normalizeInput(input: ProviderInput): StreamedModelTurnInput[] {
  return normalizeApplicationInput(input);
}

export function normalizeHistory(input: ProviderInput): ProviderInputItem[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return Array.isArray(input) ? [...input] : [input];
}

export function mergeChainedCompactionHistory(
  sessionHistory: readonly ProviderInputItem[],
  deltaHistory: readonly ProviderInputItem[],
): { kind: 'ready'; history: ProviderInputItem[] } | { kind: 'skipped'; reason: 'user_mismatch' } {
  const firstDeltaItem = deltaHistory[0];
  const normalizedDelta = normalizeApplicationInput(deltaHistory);
  if (normalizedDelta[0]?.type === 'tool_result') {
    // A tool-only continuation needs a complete snapshot with still-open
    // producing calls. Normalize supported legacy/custom forms for comparison,
    // retain original provider items, and validate every later call/receipt.
    const pending = new Map<string, string>();
    const seenCalls = new Set<string>();
    for (const item of [...normalizeApplicationInput(sessionHistory), ...normalizedDelta]) {
      if (item.type === 'tool_call') {
        if (!item.id || seenCalls.has(item.id)) return { kind: 'skipped', reason: 'user_mismatch' };
        seenCalls.add(item.id);
        pending.set(item.id, item.toolType ?? 'function');
      } else if (item.type === 'tool_result') {
        if (!item.id || pending.get(item.id) !== (item.toolType ?? 'function'))
          return { kind: 'skipped', reason: 'user_mismatch' };
        pending.delete(item.id);
      }
    }
    return { kind: 'ready', history: [...sessionHistory, ...deltaHistory] };
  }
  if (!firstDeltaItem || firstDeltaItem.type !== 'message' || firstDeltaItem.role !== 'user') {
    return { kind: 'skipped', reason: 'user_mismatch' };
  }
  let latestUserIndex = -1;
  for (let index = sessionHistory.length - 1; index >= 0; index--) {
    const item = sessionHistory[index];
    if (item.type === 'message' && item.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return { kind: 'skipped', reason: 'user_mismatch' };
  const latestSessionUser = sessionHistory[latestUserIndex];
  const normalizedDeltaUser = normalizeApplicationInput([firstDeltaItem]);
  const normalizedSessionUser = normalizeApplicationInput([latestSessionUser]);
  if (JSON.stringify(normalizedDeltaUser) !== JSON.stringify(normalizedSessionUser)) {
    return { kind: 'skipped', reason: 'user_mismatch' };
  }
  return {
    kind: 'ready',
    history: [
      ...sessionHistory.slice(0, latestUserIndex),
      firstDeltaItem,
      ...sessionHistory.slice(latestUserIndex + 1),
      ...deltaHistory.slice(1),
    ],
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function unsupportedInput(description: string): never {
  throw new Error(`Unsupported restored input ${description}`);
}

function normalizeTextPart(value: unknown, description: string): { type: 'text'; text: string } {
  if (typeof value === 'string') return { type: 'text', text: value };
  const record = asRecord(value);
  if (
    !record ||
    !['text', 'input_text', 'output_text'].includes(String(record.type)) ||
    typeof record.text !== 'string'
  ) {
    unsupportedInput(description);
  }
  return { type: 'text', text: record.text };
}

function normalizeMessageImage(record: UnknownRecord): StreamedModelMessagePart {
  const image = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (image === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof image === 'string') return { type: 'image', image, ...(detail ? { detail } : {}) };
  const reference = asRecord(image);
  if (typeof reference?.id === 'string')
    return { type: 'image', image: { id: reference.id }, ...(detail ? { detail } : {}) };
  unsupportedInput('message image reference');
}

function normalizeMessagePart(value: unknown): StreamedModelMessagePart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeMessageImage(record);
  return normalizeTextPart(value, record?.type ? `message content: ${record.type}` : 'message content');
}

function normalizeMessageContent(value: unknown): StreamedModelMessagePart[] {
  if (value === undefined || value === null) return [{ type: 'text', text: '' }];
  return (Array.isArray(value) ? value : [value]).map((part) => normalizeMessagePart(part)!);
}

function isTextMessagePart(
  part: StreamedModelMessagePart,
): part is Extract<StreamedModelMessagePart, { type: 'text' }> {
  return part.type === 'text';
}

function normalizeToolImagePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'image' }> {
  const rawImage = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (rawImage === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof rawImage === 'string') return { type: 'image', image: rawImage, ...(detail ? { detail } : {}) };
  const image = asRecord(rawImage);
  if (!image) unsupportedInput('tool image reference');
  const normalized =
    typeof image.id === 'string'
      ? { id: image.id }
      : typeof image.url === 'string'
      ? { url: image.url }
      : typeof image.fileId === 'string'
      ? { fileId: image.fileId }
      : (typeof image.data === 'string' || image.data instanceof Uint8Array) && typeof image.mediaType === 'string'
      ? { data: image.data, mediaType: image.mediaType }
      : undefined;
  if (!normalized) unsupportedInput('tool image reference');
  return { type: 'image', image: normalized, ...(detail ? { detail } : {}) };
}

function normalizeToolFilePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'file' }> {
  const rawFile = record.file ?? record.file_id ?? record.file_url;
  const outerFilename = typeof record.filename === 'string' ? record.filename : undefined;
  if (typeof rawFile === 'string') return { type: 'file', file: rawFile };
  const file = asRecord(rawFile);
  if (!file) unsupportedInput('tool file reference');
  if (typeof file.id === 'string')
    return { type: 'file', file: { id: file.id, ...(outerFilename ? { filename: outerFilename } : {}) } };
  if (typeof file.url === 'string')
    return { type: 'file', file: { url: file.url, ...(outerFilename ? { filename: outerFilename } : {}) } };
  const filename = outerFilename ?? (typeof file.filename === 'string' ? file.filename : undefined);
  if (
    (typeof file.data === 'string' || file.data instanceof Uint8Array) &&
    typeof file.mediaType === 'string' &&
    filename !== undefined
  ) {
    return { type: 'file', file: { data: file.data, mediaType: file.mediaType, filename } };
  }
  unsupportedInput('tool file reference');
}

function normalizeToolResultPart(value: unknown): StreamedModelToolResultPart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeToolImagePart(record);
  if (record?.type === 'file' || record?.type === 'input_file') return normalizeToolFilePart(record);
  return normalizeTextPart(value, record?.type ? `tool result part: ${record.type}` : 'tool result part');
}

function normalizeToolResultOutput(value: unknown): string | StreamedModelToolResultPart[] {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) unsupportedInput('tool result output');
  return value.map(normalizeToolResultPart);
}

function normalizeReasoningText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (
        !record ||
        !['reasoning_text', 'text', 'summary_text'].includes(String(record.type)) ||
        typeof record.text !== 'string'
      ) {
        return unsupportedInput('reasoning content part');
      }
      return record.text;
    })
    .join('');
}

/** True when the adapter marked this item as provider-native and opaque. */
function isProviderOpaque(
  item: ProviderInputItem,
): item is ProviderInputItem & { providerOpaque: { provider: string; sourceProvider?: string } } {
  const marker = item.providerOpaque;
  return typeof marker?.provider === 'string' && marker.provider.length > 0;
}

function normalizeInputItem(item: ProviderInputItem): StreamedModelTurnInput[] {
  if (item.type === 'provider_opaque' && typeof item.provider === 'string' && item.provider.length > 0) {
    const payload = asRecord(item.item);
    if (payload) {
      return [
        {
          type: 'provider_opaque',
          provider: item.provider,
          ...(typeof item.sourceProvider === 'string' && item.sourceProvider.length > 0
            ? { sourceProvider: item.sourceProvider }
            : {}),
          item: { ...payload },
        },
      ];
    }
  }
  if (isProviderOpaque(item)) {
    const { providerOpaque: _marker, personalMemoryContext: _personalContext, ...providerItem } = item;
    return [
      {
        type: 'provider_opaque',
        provider: item.providerOpaque.provider,
        ...(item.providerOpaque.sourceProvider ? { sourceProvider: item.providerOpaque.sourceProvider } : {}),
        item: providerItem,
      },
    ];
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    return [
      {
        type: 'tool_call',
        id: String(item.callId ?? item.call_id ?? ''),
        name: String(item.name ?? ''),
        arguments: String(item.type === 'custom_tool_call' ? item.input ?? '' : item.arguments ?? '{}'),
        ...(item.type === 'custom_tool_call' ? { toolType: 'custom' as const } : {}),
        ...(item.providerData ? { providerMetadata: item.providerData } : {}),
      },
    ];
  }
  if (
    item.type === 'function_call_result' ||
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output'
  ) {
    return [
      {
        type: 'tool_result',
        id: String(item.callId ?? item.call_id ?? item.tool_call_id ?? ''),
        output: normalizeToolResultOutput(item.output),
        ...(item.type === 'custom_tool_call_output' ? { toolType: 'custom' as const } : {}),
      },
    ];
  }
  if (item.type === 'reasoning') {
    const providerMetadata: StreamedModelProviderOptions | undefined = item.providerData;
    return [
      {
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        text: normalizeReasoningText(item.content ?? item.output ?? ''),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    ];
  }
  if (item.type !== undefined && item.type !== 'message') unsupportedInput(`item type: ${String(item.type)}`);
  const role =
    item.role === undefined
      ? 'user'
      : item.role === 'assistant' || item.role === 'system' || item.role === 'user'
      ? item.role
      : unsupportedInput(`message role: ${String(item.role)}`);
  const content = normalizeMessageContent(item.content);
  if (role === 'system') {
    const textContent = content.filter(isTextMessagePart);
    if (textContent.length !== content.length) unsupportedInput('system message content');
    return [{ type: 'message', role, content: textContent }];
  }
  return [{ type: 'message', role, content }];
}
