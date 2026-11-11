import { acceptsProviderOpaqueTag } from './provider-opaque-compatibility.js';
import type { StreamedModelTurnRequest } from '../streamed-model-turn.js';

/**
 * Serializes application history into chat-completions `messages`: content
 * parts, tool calls and results, and each turn's reasoning continuity payload
 * replayed in the spelling its provider sent. The stream side lives in
 * `openai-chat-completions-model.ts`.
 */

/**
 * Term2's own key inside a chat-completions `provider_opaque` payload: the tool
 * call ids of the response that produced it (`[]` for a response without tool
 * calls). Replay matches the payload to its turn by these ids and strips the key
 * before the payload reaches the wire. Payloads persisted before the key existed
 * lack it and fall back to positional matching, which cannot tell a payload-less
 * earlier turn from a split parallel batch.
 */
export const OPAQUE_TURN_TOOL_CALL_IDS_KEY = 'term2_turn_tool_call_ids';

/** The wire spellings a continuity payload may use for reasoning. */
const REASONING_WIRE_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'] as const;

const isOwnOpaqueTag = (tag: unknown, providerId: string): boolean =>
  typeof tag === 'string' && acceptsProviderOpaqueTag(tag, providerId);

const opaqueMarkerOf = (item: any): { provider: unknown } | undefined =>
  item.providerOpaque ?? (item.type === 'provider_opaque' ? { provider: item.provider } : undefined);

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
  // Payloads stamped with their turn's tool call ids attach by id after the
  // walk, whichever side of their turn they sit on. A stamped payload with no
  // ids belongs to a text-only turn and attaches to the next assistant message.
  const identifiedPayloads: { callIds: ReadonlySet<string>; payload: Record<string, unknown>; position: number }[] = [];
  let pendingTextTurnPayload: Record<string, unknown> | undefined;
  const turnCallIds = new WeakMap<object, ReadonlySet<string>>();
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
      const {
        providerOpaque: _marker,
        type: _type,
        [OPAQUE_TURN_TOOL_CALL_IDS_KEY]: stampedCallIds,
        ...payload
      } = rawPayload as any;
      if (Array.isArray(stampedCallIds)) {
        // A stamped payload names its own turn, so it also retires whatever the
        // positional fallback was holding for an older, payload-less turn.
        pendingOpaqueTarget = undefined;
        pendingOpaquePayload = undefined;
        leadingPayloadGroupOpen = false;
        if (stampedCallIds.length > 0) {
          identifiedPayloads.push({
            callIds: new Set(stampedCallIds.map(String)),
            payload,
            position: messages.length,
          });
        } else {
          pendingTextTurnPayload = payload;
        }
        continue;
      }
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
        pendingTextTurnPayload = undefined;
        leadingPayloadGroupOpen = false;
      }
      if (item.role === 'assistant' && pendingTextTurnPayload) {
        attachOpaquePayload(message, pendingTextTurnPayload);
        pendingTextTurnPayload = undefined;
      } else if (item.role === 'assistant') registerAssistant(message);
      if (item.role === 'assistant') pendingLegacyNativeReasoning = '';
      continue;
    }
    if (item.type === 'tool_call') {
      const toolCall = { id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const previous = messages[messages.length - 1];
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else if (previous?.role === 'assistant' && previous.content != null) {
        // Prose the same turn produced, immediately before its tool calls: a
        // user or tool message would separate two different turns. One turn
        // must stay one assistant message so its continuity payload and tool
        // calls remain on the same wire message.
        previous.tool_calls = [toolCall];
        registerAssistant(previous);
      } else {
        const message = {
          role: 'assistant',
          ...(hasReasoningFields() ? { content: null, ...reasoningFields() } : {}),
          tool_calls: [toolCall],
        };
        messages.push(message);
        registerAssistant(message);
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
  // Providers may reuse tool call ids across responses, so an id alone does not
  // name a turn. Search outward from where the payload sat, only as far as the
  // nearest user message or other stamped payload: forward first (the order the
  // producer emits), then backward (a payload trailing its turn's results).
  const boundaries = new Set<number>(identifiedPayloads.map(({ position }) => position));
  messages.forEach((message, index) => {
    if (message.role === 'user') boundaries.add(index);
  });
  const ownsCall = (message: any, callIds: ReadonlySet<string>): boolean =>
    message.role === 'assistant' &&
    !turnCallIds.has(message) &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.some((call: any) => callIds.has(call.id));
  for (const { callIds, payload, position } of identifiedPayloads) {
    let target: any;
    for (let index = position; index < messages.length && !target; index += 1) {
      if ((index > position && boundaries.has(index)) || messages[index].role === 'user') break;
      if (ownsCall(messages[index], callIds)) target = messages[index];
    }
    // Trailing: the payload follows its turn's results. A batch that history
    // split into call/result pairs is several messages, so keep walking back to
    // the earliest of them (coalescing re-merges the rest forward), but stop at
    // a repeated id, which belongs to an earlier turn.
    const seen = new Set<string>();
    for (let index = position - 1; index >= 0 && target === undefined; index -= 1) {
      if (!ownsCall(messages[index], callIds)) {
        if (boundaries.has(index)) break;
        continue;
      }
      let earliest = index;
      for (let earlier = index; earlier >= 0; earlier -= 1) {
        const message = messages[earlier];
        if (message.role === 'tool') continue;
        if (!ownsCall(message, callIds)) break;
        const ids = message.tool_calls.map((call: any) => call.id);
        if (ids.some((id: string) => seen.has(id))) break;
        ids.forEach((id: string) => seen.add(id));
        earliest = earlier;
      }
      target = messages[earliest];
    }
    if (!target) continue;
    attachOpaquePayload(target, payload);
    turnCallIds.set(target, callIds);
  }
  return coalesceReasoningToolCallBatches(messages, turnCallIds);
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

/**
 * Re-merge a reasoning turn's tool calls that history split across several
 * assistant messages. When the turn's call ids are known (`turnCallIds`), only
 * messages whose calls all belong to that turn merge; otherwise any following
 * payload-less tool-call message does, which is the positional fallback.
 */
function coalesceReasoningToolCallBatches(
  messages: any[],
  turnCallIds: WeakMap<object, ReadonlySet<string>> = new WeakMap(),
): any[] {
  const result: any[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const hasReasoning =
      message?.role === 'assistant' &&
      (message.reasoning_content != null || message.reasoning != null || message.reasoning_details != null);
    if (!hasReasoning || !Array.isArray(message.tool_calls)) {
      result.push(message);
      continue;
    }

    const ownCallIds = turnCallIds.get(message);
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
        Array.isArray(next.tool_calls) &&
        next.reasoning_content == null &&
        next.reasoning == null &&
        next.reasoning_details == null &&
        next.content == null &&
        (!ownCallIds ||
          next.tool_calls.every(
            (call: any) =>
              ownCallIds.has(call.id) && !message.tool_calls.some((existing: any) => existing.id === call.id),
          ))
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
