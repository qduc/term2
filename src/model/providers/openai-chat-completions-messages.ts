import { isDeepStrictEqual } from 'node:util';
import { acceptsProviderOpaqueTag } from './provider-opaque-compatibility.js';
import type { StreamedModelTurnRequest } from '../streamed-model-turn.js';

/**
 * Serializes application history into chat-completions `messages`: content
 * parts, tool calls and results, and each turn's reasoning continuity payload
 * replayed in the spelling its provider sent. The stream side lives in
 * `openai-chat-completions-model.ts`.
 */

/** The wire spellings a continuity payload may use for reasoning. */
const REASONING_WIRE_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'] as const;

const isOwnOpaqueTag = (tag: unknown, providerId: string): boolean =>
  typeof tag === 'string' && acceptsProviderOpaqueTag(tag, providerId);

const opaqueMarkerOf = (item: any): { provider: unknown } | undefined =>
  item.providerOpaque ?? (item.type === 'provider_opaque' ? { provider: item.provider } : undefined);

/** The SDK stored these on reasoning items and the first tool call, not opaque items. */
function legacyOpenRouterDetails(item: any, providerId: string): unknown[] | undefined {
  if (providerId !== 'openrouter') return undefined;
  const details = item.providerMetadata?.openrouter?.reasoning_details;
  return Array.isArray(details) ? details : undefined;
}

function appendLegacyDetails(existing: unknown[], incoming: unknown[]): unknown[] {
  const result = [...existing];
  for (const detail of incoming) {
    // Old tool-call copies can contain null-data encrypted placeholders. The
    // SDK rejected those; retain the complete reasoning-item copy instead.
    if (!detail || typeof detail !== 'object') continue;
    if (
      'type' in detail &&
      detail.type === 'reasoning.encrypted' &&
      (!('data' in detail) || typeof detail.data !== 'string')
    )
      continue;
    if (!result.some((previous) => isDeepStrictEqual(previous, detail))) result.push(detail);
  }
  return result;
}

/** Build the chat-completions image_url for an application image reference. */
function toChatImageUrl(image: unknown): string | undefined {
  if (typeof image === 'string') return image;
  if (!image || typeof image !== 'object') return undefined;
  const record = image as { url?: unknown; id?: unknown; data?: unknown; mediaType?: unknown };
  if (typeof record.url === 'string') return record.url;
  if (typeof record.id === 'string') return record.id;
  if (typeof record.data === 'string' || record.data instanceof Uint8Array) {
    const data = typeof record.data === 'string' ? record.data : Buffer.from(record.data).toString('base64');
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream';
    return `data:${mediaType};base64,${data}`;
  }
  return undefined;
}

/** A single chat-completions content part produced from an application part. */
type ChatContentPart = { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string };

/** Convert one application content part to a chat-completions content part. */
function toChatContentPart(part: any): ChatContentPart {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (part?.type === 'image') {
    const url = toChatImageUrl(part.image);
    // An unrecognized image reference has no URL to send. Emitting
    // `image_url: { url: undefined }` would put a malformed part on the wire
    // and fail the whole request, so describe it as text instead.
    if (url === undefined) return { type: 'text', text: '[unsupported image content omitted]' };
    return { type: 'image_url', image_url: { url } };
  }
  return { type: 'text', text: part?.text ?? '' };
}

/**
 * Serialize a tool-result output for the chat-completions wire. Multimodal
 * content-part arrays (read_file images) become content parts so the image
 * reaches the model; a plain string or a single structured value stays text.
 */
function toChatToolResultContent(output: unknown): string | ChatContentPart[] {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((part: any) => toChatContentPart(part));
  return JSON.stringify(output);
}

export function openAICompatibleMessages(
  input: StreamedModelTurnRequest['input'],
  providerId = 'openai-compatible',
): any[] {
  const messages: any[] = [];
  // Depending on whether history came straight from the run loop or persistence,
  // a continuity payload can lead or trail the assistant group it describes.
  // Keep only the open group association; do not pair whole-history arrays by
  // position because assistant groups can be coalesced.
  let pendingOpaqueTarget: any | undefined;
  let pendingOpaquePayload: Record<string, unknown> | undefined;
  let leadingPayloadGroupOpen = false;
  const registerAssistant = (message: any): void => {
    if (pendingOpaquePayload) {
      attachOpaquePayload(message, pendingOpaquePayload);
      pendingOpaquePayload = undefined;
      leadingPayloadGroupOpen = true;
      return;
    }
    if (leadingPayloadGroupOpen) return;
    if (!pendingOpaqueTarget) pendingOpaqueTarget = message;
  };
  // Native reasoning restored from a conversation persisted before the opaque
  // lane existed, recognized by its `providerMetadata` marker.
  let pendingLegacyNativeReasoning = '';
  let pendingLegacyOpenRouter = false;
  let pendingLegacyOpenRouterDetails: unknown[] = [];
  let pendingLegacyOpenRouterText = '';
  const legacyAssistantGroups = new Set<unknown>();

  const attachLegacyOpenRouter = (message: any, item: any): void => {
    const details = legacyOpenRouterDetails(item, providerId);
    if (!pendingLegacyOpenRouter && details === undefined) return;
    const merged = appendLegacyDetails(
      appendLegacyDetails(message.reasoning_details ?? [], pendingLegacyOpenRouterDetails),
      details ?? [],
    );
    if (merged.length) {
      message.reasoning_details = merged;
      if (pendingLegacyOpenRouterText) message.reasoning = pendingLegacyOpenRouterText;
      if (!('content' in message)) message.content = null;
    }
    legacyAssistantGroups.add(message);
    // An explicit legacy group is complete, even when its state array is empty.
    // A subsequent leading opaque payload belongs to the next assistant group.
    if (pendingOpaqueTarget === message) pendingOpaqueTarget = undefined;
    leadingPayloadGroupOpen = false;
    pendingLegacyOpenRouter = false;
    pendingLegacyOpenRouterDetails = [];
    pendingLegacyOpenRouterText = '';
  };

  // Whether this history carries any continuity payload of ours. When it does,
  // every bare `reasoning` item in it is the normalized twin of a payload
  // rather than another provider's reasoning, and replaying it as text would
  // send the same tokens twice.
  const historyCarriesOwnOpaque = (input as any[]).some((item) =>
    isOwnOpaqueTag(opaqueMarkerOf(item)?.provider, providerId),
  );

  const reasoningFields = (): Record<string, unknown> =>
    pendingLegacyNativeReasoning ? { reasoning_content: pendingLegacyNativeReasoning } : {};
  const hasReasoningFields = () => pendingLegacyNativeReasoning.length > 0;

  for (const rawItem of input as any[]) {
    const item = rawItem as any;
    const providerOpaque = opaqueMarkerOf(item);
    if (providerOpaque) {
      const tag = providerOpaque.provider;
      // A continuity payload from another provider is inert baggage left by a
      // provider switch, not a fault. Drop it and keep replaying the rest of
      // the history. See `provider-opaque-compatibility.ts`.
      if (!isOwnOpaqueTag(tag, providerId)) continue;
      const rawPayload = item.type === 'provider_opaque' ? item.item : item;
      const { providerOpaque: _marker, type: _type, ...payload } = rawPayload as any;
      // A normalized reasoning item immediately before the payload is its
      // leading twin. It is also an explicit boundary that retires any older
      // assistant group which emitted no opaque payload.
      if (hasReasoningFields()) {
        pendingOpaqueTarget = undefined;
        pendingOpaquePayload = payload;
        leadingPayloadGroupOpen = false;
      } else if (pendingOpaqueTarget) {
        attachOpaquePayload(pendingOpaqueTarget, payload);
        pendingOpaqueTarget = undefined;
        leadingPayloadGroupOpen = false;
      } else {
        pendingOpaquePayload = payload;
        leadingPayloadGroupOpen = false;
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const legacyDetails = legacyOpenRouterDetails(item, providerId);
      if (legacyDetails !== undefined) {
        pendingLegacyOpenRouter = true;
        pendingLegacyOpenRouterDetails = appendLegacyDetails(pendingLegacyOpenRouterDetails, legacyDetails);
        if (typeof item.text === 'string') pendingLegacyOpenRouterText += item.text;
        continue;
      }
      const directNativeReasoning = item.providerMetadata?.reasoning_content;
      // Persistence intentionally removes the duplicate text field from a
      // standalone reasoning item, so the marker is what identifies restored
      // native reasoning from before the opaque lane.
      const legacyNativeReasoning =
        typeof directNativeReasoning === 'string'
          ? directNativeReasoning
          : item.providerMetadata?.openai_compatible_reasoning_content === true
          ? item.text
          : undefined;
      if (typeof legacyNativeReasoning === 'string') {
        pendingLegacyNativeReasoning += legacyNativeReasoning;
      } else if (!historyCarriesOwnOpaque && typeof item.text === 'string') {
        // Reasoning from a provider with no chat-completions wire form (an
        // Anthropic thinking block restored across a model switch, say). It is
        // not this provider's `reasoning_content`, and inventing that field
        // would hand one provider another's private state. Retain it as plain
        // assistant text, the only shape this wire has for it.
        messages.push({ role: 'assistant', content: item.text });
      }
      continue;
    }
    if (item.type === 'message') {
      const content = item.content.map((part: any) => {
        if (part.type === 'image') {
          const image = part.image;
          const url = typeof image === 'string' ? image : image?.id;
          return { type: 'image_url', image_url: { url } };
        }
        return { type: 'text', text: part.text };
      });
      const message = {
        role: item.role,
        content,
        ...(item.role === 'assistant' && hasReasoningFields() ? reasoningFields() : {}),
      };
      messages.push(message);
      if (item.role === 'user') {
        pendingOpaqueTarget = undefined;
        pendingOpaquePayload = undefined;
        leadingPayloadGroupOpen = false;
        pendingLegacyOpenRouter = false;
        pendingLegacyOpenRouterDetails = [];
        pendingLegacyOpenRouterText = '';
      }
      if (item.role === 'assistant') {
        registerAssistant(message);
        attachLegacyOpenRouter(message, item);
      }
      if (item.role === 'assistant') pendingLegacyNativeReasoning = '';
      continue;
    }
    if (item.type === 'tool_call') {
      const toolCall = { id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const previous = messages[messages.length - 1];
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
        attachLegacyOpenRouter(previous, item);
      } else if (previous?.role === 'assistant' && previous.content != null) {
        // Prose the same turn produced, immediately before its tool calls: a
        // user or tool message would separate two different turns. One turn
        // must stay one assistant message so its continuity payload and tool
        // calls remain on the same wire message.
        previous.tool_calls = [toolCall];
        registerAssistant(previous);
        attachLegacyOpenRouter(previous, item);
      } else {
        const message = {
          role: 'assistant',
          ...(hasReasoningFields() ? { content: null, ...reasoningFields() } : {}),
          tool_calls: [toolCall],
        };
        messages.push(message);
        registerAssistant(message);
        attachLegacyOpenRouter(message, item);
      }
      pendingLegacyNativeReasoning = '';
      continue;
    }
    if (item.type === 'tool_result') {
      // A multimodal content-part array (read_file images) becomes content
      // parts so the image reaches the model; JSON-stringifying the array
      // would deliver "[{...},{...}]" instead of the image.
      messages.push({ role: 'tool', tool_call_id: item.id, content: toChatToolResultContent(item.output) });
    }
  }

  // Chat Completions requires assistant messages to contain content or tool
  // calls. Native reasoning is continuation metadata for the matching assistant
  // message/tool call, not a valid standalone message; if no such item follows
  // — an interrupted turn — omit it rather than inventing a message to carry
  // it or back-dating it onto an earlier one that did not produce it.
  return coalesceReasoningToolCallBatches(messages, legacyAssistantGroups);
}

function attachOpaquePayload(target: any, payload: Record<string, unknown>): void {
  // The payload carries this turn's reasoning in the provider's own spelling,
  // so it supersedes any normalized `reasoning_content` reconstructed for the
  // same message — keeping both would send the same tokens twice, in two
  // different fields.
  for (const field of REASONING_WIRE_FIELDS) {
    if (!(field in payload)) delete target[field];
  }
  Object.assign(target, payload);
  // A reasoning-bearing tool-call message states `content: null` explicitly
  // rather than omitting it; a payload that adds the reasoning has to carry
  // that pairing too, or the two ways a message can acquire reasoning would
  // serialize differently.
  if (Array.isArray(target.tool_calls) && !('content' in target)) target.content = null;
}

function coalesceReasoningToolCallBatches(messages: any[], legacyAssistantGroups: ReadonlySet<unknown>): any[] {
  const result: any[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const hasReasoning =
      message?.role === 'assistant' &&
      (message.reasoning_content != null || message.reasoning != null || message.reasoning_details != null);
    // Legacy groups are already formed from consecutive assistant/tool-call
    // items. Do not absorb a later response across their tool-result boundary.
    if (!hasReasoning || !Array.isArray(message.tool_calls) || legacyAssistantGroups.has(message)) {
      result.push(message);
      continue;
    }

    const toolResults: any[] = [];
    while (index + 1 < messages.length) {
      const next = messages[index + 1];
      if (next?.role === 'tool') {
        toolResults.push(next);
        index += 1;
        continue;
      }
      if (
        next?.role === 'assistant' &&
        !legacyAssistantGroups.has(next) &&
        Array.isArray(next.tool_calls) &&
        next.reasoning_content == null &&
        next.reasoning == null &&
        next.reasoning_details == null &&
        next.content == null
      ) {
        message.tool_calls.push(...next.tool_calls);
        index += 1;
        continue;
      }
      break;
    }
    result.push(message, ...toolResults);
  }
  return result;
}
