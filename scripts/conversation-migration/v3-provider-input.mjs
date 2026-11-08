// Frozen v3 provider-input projection moved from the removed runtime (#197).
// Offline conversion only; the live engine does not use this compatibility policy.
import { humanArrivalNotice } from '../../dist/src/shared/conversation/conversation-time-gap.js';
import { personalMemoryNotice } from '../../dist/src/shared/conversation/personal-memory-context.js';
function formatConversationTimeGap(value) {
  if (!value || typeof value !== 'object') return null;
  return humanArrivalNotice(value.previousReceivedAt, value.receivedAt);
}
/**
 * Project validated v3 history using its historical provider-input encoding.
 * Kept solely for offline migration; rejects unsupported legacy content.
 */
export function normalizeApplicationInput(input) {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  const items = Array.isArray(input) ? input : [input];
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
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function unsupportedInput(description) {
  throw new Error(`Unsupported restored input ${description}`);
}
function normalizeTextPart(value, description) {
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
function normalizeMessageImage(record) {
  const image = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (image === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof image === 'string') return { type: 'image', image, ...(detail ? { detail } : {}) };
  const reference = asRecord(image);
  if (typeof reference?.id === 'string')
    return { type: 'image', image: { id: reference.id }, ...(detail ? { detail } : {}) };
  unsupportedInput('message image reference');
}
function normalizeMessagePart(value) {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeMessageImage(record);
  return normalizeTextPart(value, record?.type ? `message content: ${record.type}` : 'message content');
}
function normalizeMessageContent(value) {
  if (value === undefined || value === null) return [{ type: 'text', text: '' }];
  return (Array.isArray(value) ? value : [value]).map((part) => normalizeMessagePart(part));
}
function isTextMessagePart(part) {
  return part.type === 'text';
}
function normalizeToolImagePart(record) {
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
function normalizeToolFilePart(record) {
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
function normalizeToolResultPart(value) {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeToolImagePart(record);
  if (record?.type === 'file' || record?.type === 'input_file') return normalizeToolFilePart(record);
  return normalizeTextPart(value, record?.type ? `tool result part: ${record.type}` : 'tool result part');
}
function normalizeToolResultOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  // Older Agents SDK logs store a single output part as a bare object.
  if (asRecord(value)) value = [value];
  if (!Array.isArray(value)) unsupportedInput('tool result output');
  return value.map(normalizeToolResultPart);
}
function normalizeReasoningText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (
        !record ||
        !['reasoning_text', 'text', 'summary_text', 'input_text'].includes(String(record.type)) ||
        typeof record.text !== 'string'
      ) {
        return unsupportedInput('reasoning content part');
      }
      return record.text;
    })
    .join('');
}
/** True when the adapter marked this item as provider-native and opaque. */
function isProviderOpaque(item) {
  const marker = item.providerOpaque;
  return typeof marker?.provider === 'string' && marker.provider.length > 0;
}
function normalizeInputItem(item) {
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
        ...(item.type === 'custom_tool_call' ? { toolType: 'custom' } : {}),
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
        ...(item.type === 'custom_tool_call_output' ? { toolType: 'custom' } : {}),
      },
    ];
  }
  if (item.type === 'reasoning') {
    const providerMetadata = item.providerData;
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
