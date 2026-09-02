import { assertValidOpenAICompatibleMessages } from './common/openai-compatible-message-contract.js';
import { OpenAICompatibleError } from './common/provider-errors.js';
import { acceptsProviderOpaqueTag } from './provider-opaque-compatibility.js';
import type { CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
  StreamedModelUsage,
} from '../contracts/streamed-model-turn.js';

const MAX_TRIVIAL_WHITESPACE_LENGTH = 4;

function isTrivialWhitespace(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TRIVIAL_WHITESPACE_LENGTH && text.trim() === '';
}

/** Application-owned adapter for OpenAI-compatible chat-completions endpoints. */
export class OpenAIChatCompletionsModel implements StreamedModelTurn {
  private readonly client: any;
  private readonly model: string;
  private readonly costCapture?: CostTrailerCapture;
  private readonly providerId: string;

  constructor(client: any, model: string, costCapture?: CostTrailerCapture, providerId?: string) {
    this.client = client;
    this.model = model.trim();
    this.costCapture = costCapture;
    this.providerId = providerId ?? 'openai-compatible';
  }

  // createCustomProviderModelProvider() (openai-compatible.provider.ts) returns
  // this class for the 'openai'/'openai-compatible'/'llama.cpp' provider types,
  // and every caller requires a `getStreamedModel()` method — the class already
  // implements StreamedModelTurn directly via `stream()`, so it just returns itself.
  getStreamedModel(): this {
    return this;
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    const messages = [
      ...(request.instructions ? [{ role: 'system', content: request.instructions }] : []),
      ...openAICompatibleMessages(request.input, this.providerId),
    ];
    assertValidOpenAICompatibleMessages(messages);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      // Streaming omits usage unless the request opts in. Without this the
      // status bar has no token counts, context gauge, or cost for any
      // chat-completions provider. Placed before `providerOptions` so a
      // provider whose server rejects it can override.
      stream_options: { include_usage: true },
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
      ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: toChatToolChoice(request.toolChoice) } : {}),
      ...(request.reasoning?.effort ? { reasoning_effort: request.reasoning.effort } : {}),
      ...(request.providerOptions ?? {}),
      ...(request.outputType && request.outputType !== 'text'
        ? { response_format: toChatResponseFormat(request.outputType) }
        : {}),
      signal: request.signal,
    });
    // Keyed by the tool call's stream `index`, which every provider sends on
    // every chunk. `id` (and often `name`) only arrives on the first chunk for
    // that index; later chunks carry just `{ index, function: { arguments } }`
    // with no `id`. Keying by `id ?? index` used to split one tool call into
    // two accumulator entries once the id-less chunks fell back to the index key.
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let text = '';
    let reasoning = '';
    const rawContinuityMetadata: Record<string, unknown> = {};
    let sawFinishReason = false;
    let finishReason: string | undefined;
    let usage: StreamedModelUsage | undefined;
    let costUsd: number | string | undefined;
    let pendingTrivialWhitespace = '';
    let hasMaterialOutput = false;
    let sawErrorFinish = false;
    let errorFinishPayload: unknown;
    // Keep only a bounded leading prefix uncommitted. This lets an immediately
    // following in-band error retry without weakening RetryingModel's rule
    // that every yielded event commits the attempt.
    const flushPendingWhitespace = (): string | undefined => {
      if (!pendingTrivialWhitespace) return undefined;
      const text = pendingTrivialWhitespace;
      pendingTrivialWhitespace = '';
      hasMaterialOutput = true;
      return text;
    };
    for await (const chunk of response) {
      if ((chunk as any).error != null) {
        pendingTrivialWhitespace = '';
        throw normalizeChatCompletionError((chunk as any).error);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason != null) {
        sawFinishReason = true;
        finishReason = choice.finish_reason;
      }
      if (delta) {
        for (const [key, val] of Object.entries(delta)) {
          // `role` is response-only; `content`/`tool_calls` are modeled above.
          // Everything else is continuity metadata by default — the failure this
          // capture exists to fix was an unknown field being dropped because
          // nobody had enumerated it.
          if (key === 'role' || key === 'content' || key === 'tool_calls' || key === 'finish_reason') {
            continue;
          }
          if (val == null) continue;
          accumulateContinuityField(rawContinuityMetadata, key, val);
        }
      }
      // deepseek-style servers stream reasoning on `reasoning_content`;
      // OpenRouter-style gateways use `reasoning`. Reading only the former
      // silently dropped every reasoning token from the latter.
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoningDelta) {
        const flushedWhitespace = flushPendingWhitespace();
        if (flushedWhitespace) {
          text += flushedWhitespace;
          yield { type: 'text_delta', text: flushedWhitespace };
        }
        reasoning += reasoningDelta;
        yield {
          type: 'reasoning_delta',
          text: reasoningDelta,
          providerMetadata: {
            reasoning_content: reasoningDelta,
            openai_compatible_reasoning_content: true,
          },
        };
        hasMaterialOutput = true;
      }
      if (delta?.content) {
        const shouldHoldWhitespace =
          !hasMaterialOutput &&
          isTrivialWhitespace(delta.content) &&
          pendingTrivialWhitespace.length + delta.content.length <= MAX_TRIVIAL_WHITESPACE_LENGTH;
        if (shouldHoldWhitespace) {
          pendingTrivialWhitespace += delta.content;
        } else {
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) {
            text += flushedWhitespace;
            yield { type: 'text_delta', text: flushedWhitespace };
          }
          text += delta.content;
          hasMaterialOutput = true;
          yield { type: 'text_delta', text: delta.content };
        }
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = calls.get(index) ?? { name: '', arguments: '' };
        if (call.id) current.id = call.id;
        current.name += call.function?.name ?? '';
        const argumentDelta = call.function?.arguments ?? '';
        current.arguments += argumentDelta;
        calls.set(index, current);
        if (argumentDelta) {
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) {
            text += flushedWhitespace;
            yield { type: 'text_delta', text: flushedWhitespace };
          }
          yield {
            type: 'tool_call_streaming_delta',
            ...(current.name ? { toolName: current.name } : {}),
            argumentCharCount: current.arguments.length,
          };
          hasMaterialOutput = true;
        }
      }
      if (chunk.usage) {
        // Chat providers place usage on the terminal chunk rather than a
        // delta. Retain the latest frame for the application completion;
        // providers may omit it entirely.
        usage = normalizeChatUsage(chunk.usage) as typeof usage;
        if (chunk.usage.cost !== undefined && costUsd === undefined) {
          costUsd = chunk.usage.cost;
        }
      }
      if ((chunk as any).cost !== undefined && costUsd === undefined) {
        costUsd = (chunk as any).cost;
      }
      if (choice?.finish_reason === 'error') {
        sawErrorFinish = true;
        errorFinishPayload = (chunk as any).error ?? choice?.error;
      }
    }
    if (!sawFinishReason) throw new Error('OpenAI-compatible streamed response ended without a finish reason');
    if (sawErrorFinish) {
      pendingTrivialWhitespace = '';
      throw normalizeChatCompletionError(errorFinishPayload);
    }
    const flushedWhitespace = flushPendingWhitespace();
    if (flushedWhitespace) {
      text += flushedWhitespace;
      yield { type: 'text_delta', text: flushedWhitespace };
    }
    for (const [index, call] of calls)
      yield { type: 'tool_call', id: call.id ?? `call_${index}`, name: call.name, arguments: call.arguments };

    const output: any[] = [];
    if (reasoning) {
      output.push({
        type: 'reasoning',
        text: reasoning,
      });
    }
    if (Object.keys(rawContinuityMetadata).length > 0) {
      output.push({
        type: 'provider_opaque',
        provider: this.providerId,
        item: rawContinuityMetadata,
      });
    }
    // A choice may carry prose and tool calls together. Emitting only the tool
    // calls erased what the assistant told the user from history, so every
    // later request replayed the turn as a bare `content: null` tool call.
    if (text || !calls.size) {
      output.push({ type: 'message', content: [{ type: 'text', text }] });
    }
    if (calls.size) {
      output.push(
        ...[...calls].map(([index, call]) => ({
          type: 'tool_call' as const,
          id: call.id ?? `call_${index}`,
          name: call.name,
          arguments: call.arguments,
        })),
      );
    }

    yield {
      type: 'completion',
      responseId: `chatcmpl-${Date.now()}`,
      ...(finishReason !== undefined ? { finishReason } : {}),
      usage,
      ...(this.costCapture?.cost !== undefined
        ? { costUsd: this.costCapture.cost }
        : costUsd !== undefined
        ? { costUsd }
        : {}),
      output,
    };
  }
}

function toChatResponseFormat(outputType: Exclude<NonNullable<StreamedModelTurnRequest['outputType']>, 'text'>): any {
  return {
    type: 'json_schema',
    json_schema: {
      name: outputType.name,
      strict: outputType.strict,
      schema: outputType.schema,
    },
  };
}

function toChatToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>): any {
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.name } };
  return choice;
}

function normalizeChatUsage(usage: any): StreamedModelUsage {
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens;
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details ?? usage?.inputTokensDetails;
  const cachedInputTokens =
    usage?.cached_tokens ?? usage?.cachedTokens ?? details?.cached_tokens ?? details?.cachedTokens;
  const cacheWriteTokens =
    usage?.cache_write_tokens ??
    usage?.cacheWriteTokens ??
    usage?.cache_creation_input_tokens ??
    usage?.cache_creation_tokens ??
    details?.cache_write_tokens ??
    details?.cacheWriteTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function normalizeChatCompletionError(error: unknown): OpenAICompatibleError {
  const record = isRecord(error) ? error : undefined;
  const nested = record && isRecord(record.error) ? record.error : undefined;
  const code = record?.code ?? record?.status ?? record?.statusCode ?? nested?.code ?? nested?.status;
  const numericStatus =
    typeof code === 'number' && Number.isInteger(code)
      ? code
      : typeof code === 'string' && /^\d+$/.test(code.trim())
      ? Number(code)
      : undefined;
  const symbolicCode = typeof code === 'string' ? code.toLowerCase() : '';
  const status =
    numericStatus ??
    (symbolicCode.includes('rate_limit') || symbolicCode.includes('too_many_requests')
      ? 429
      : symbolicCode.includes('invalid')
      ? 400
      : symbolicCode.includes('auth')
      ? 401
      : symbolicCode.includes('permission')
      ? 403
      : symbolicCode.includes('not_found')
      ? 404
      : 502);
  const message =
    (typeof record?.message === 'string' && record.message) ||
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof error === 'string' ? error : 'OpenAI-compatible provider returned an in-band error');
  let responseBody: string | undefined;
  try {
    responseBody = JSON.stringify(error);
  } catch {
    responseBody = undefined;
  }
  return new OpenAICompatibleError(message, status, {}, responseBody);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Accumulates one non-modeled `delta` field into the turn's continuity payload.
 *
 * Chat Completions streams `delta.*` as increments, so strings concatenate.
 * Arrays are the case that needs care: providers stream `reasoning_details` as
 * repeated entries carrying the same `index`, and that `index` identifies one
 * logical entry rather than one chunk. Appending blindly replays a single entry
 * as N fragments, which is the opposite of the verbatim round-trip this payload
 * exists for — and would split a signature or encrypted blob across entries.
 */
function accumulateContinuityField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string') {
    const existing = typeof target[key] === 'string' ? (target[key] as string) : '';
    target[key] = existing + value;
    return;
  }
  if (Array.isArray(value)) {
    const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
    target[key] = mergeIndexedEntries(existing, value);
    return;
  }
  target[key] = value;
}

function mergeIndexedEntries(existing: unknown[], incoming: unknown[]): unknown[] {
  const result = [...existing];
  for (const entry of incoming) {
    const index = isRecord(entry) ? entry.index : undefined;
    const matchAt =
      typeof index === 'number'
        ? result.findIndex((candidate) => isRecord(candidate) && candidate.index === index)
        : -1;
    if (matchAt === -1) {
      result.push(isRecord(entry) ? { ...entry } : entry);
      continue;
    }
    result[matchAt] = mergeEntryFields(result[matchAt] as Record<string, unknown>, entry as Record<string, unknown>);
  }
  return result;
}

/**
 * Merges a later chunk of an indexed entry into the entry accumulated so far.
 *
 * Within one entry the payload field (`text`, or whatever a future entry type
 * names it) arrives in pieces while the descriptors (`type`, `format`, `index`)
 * arrive identical on every chunk. There is no type-level way to tell them
 * apart, so an identical repeat is treated as a descriptor and a differing
 * value as a continuation. The one case this reads wrong — two consecutive
 * byte-identical payload chunks — loses a duplicate fragment, which is a
 * smaller harm than fragmenting the entry or truncating a blob.
 */
function mergeEntryFields(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'string' && typeof merged[key] === 'string' && merged[key] !== value) {
      merged[key] = (merged[key] as string) + value;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** The wire spellings a continuity payload may use for reasoning. */
const REASONING_WIRE_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'] as const;

const isOwnOpaqueTag = (tag: unknown, providerId: string): boolean =>
  typeof tag === 'string' && acceptsProviderOpaqueTag(tag, providerId);

const opaqueMarkerOf = (item: any): { provider: unknown } | undefined =>
  item.providerOpaque ?? (item.type === 'provider_opaque' ? { provider: item.provider } : undefined);

function openAICompatibleMessages(input: StreamedModelTurnRequest['input'], providerId = 'openai-compatible'): any[] {
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
      }
      if (item.role === 'assistant') registerAssistant(message);
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
      messages.push({
        role: 'tool',
        tool_call_id: item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      });
    }
  }

  // Chat Completions requires assistant messages to contain content or tool
  // calls. Native reasoning is continuation metadata for the matching assistant
  // message/tool call, not a valid standalone message; if no such item follows
  // — an interrupted turn — omit it rather than inventing a message to carry
  // it or back-dating it onto an earlier one that did not produce it.
  return coalesceReasoningToolCallBatches(messages);
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

function coalesceReasoningToolCallBatches(messages: any[]): any[] {
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
