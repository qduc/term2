import { randomUUID } from 'node:crypto';
import { assertValidOpenAICompatibleMessages } from './common/openai-compatible-message-contract.js';
import { OpenAICompatibleError } from './common/provider-errors.js';
import { OPAQUE_TURN_TOOL_CALL_IDS_KEY, openAICompatibleMessages } from './openai-chat-completions-messages.js';
import type { CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
  StreamedModelUsage,
} from '../streamed-model-turn.js';

const MAX_TRIVIAL_WHITESPACE_LENGTH = 4;

function isTrivialWhitespace(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TRIVIAL_WHITESPACE_LENGTH && text.trim() === '';
}

/** Where one endpoint departs from the plain chat-completions conventions. */
export type OpenAIChatCompletionsDialect = {
  /** Explicit wire convention for endpoints that differ from the detected host. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /**
   * The body fields carrying the selected reasoning effort and the caller's
   * provider options. The default sends `reasoning_effort` and spreads the
   * options verbatim; a gateway that nests effort or namespaces its options
   * supplies its own.
   */
  readonly requestOptions?: (request: StreamedModelTurnRequest) => Record<string, unknown>;
  /**
   * An aggregator names the upstream that served the request in a top-level
   * `provider` field on each chunk. Other servers use that field for their own
   * name, which is not an upstream, so reading it is opt-in.
   */
  readonly reportsUpstreamProvider?: boolean;
};

const defaultRequestOptions = (request: StreamedModelTurnRequest): Record<string, unknown> => ({
  ...(request.reasoning?.effort ? { reasoning_effort: request.reasoning.effort } : {}),
  ...(request.providerOptions ?? {}),
});

function tokenLimitField(client: any): 'max_tokens' | 'max_completion_tokens' {
  try {
    // OpenAI's current Chat API uses max_completion_tokens. Compatible servers
    // retain their own convention; neither provider labels nor model versions
    // establish that their endpoint implements OpenAI's newer parameter.
    if (new URL(client.baseURL).hostname === 'api.openai.com') return 'max_completion_tokens';
  } catch {
    // A non-URL test client or opaque custom endpoint retains the legacy field.
  }
  return 'max_tokens';
}

/** Application-owned adapter for OpenAI-compatible chat-completions endpoints. */
export class OpenAIChatCompletionsModel implements StreamedModelTurn {
  private readonly client: any;
  private readonly model: string;
  private readonly costCapture?: CostTrailerCapture;
  private readonly providerId: string;
  private readonly dialect: OpenAIChatCompletionsDialect;

  constructor(
    client: any,
    model: string,
    costCapture?: CostTrailerCapture,
    providerId?: string,
    dialect: OpenAIChatCompletionsDialect = {},
  ) {
    this.client = client;
    this.model = model.trim();
    this.costCapture = costCapture;
    this.providerId = providerId ?? 'openai-compatible';
    this.dialect = dialect;
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
    const providerOptions = (this.dialect.requestOptions ?? defaultRequestOptions)(request);
    // A caller-supplied limit wins regardless of which spelling it uses. Do
    // not add the other spelling alongside it: OpenAI rejects both together.
    const limit =
      request.maxTokens !== undefined &&
      providerOptions.max_tokens === undefined &&
      providerOptions.max_completion_tokens === undefined
        ? { [this.dialect.maxTokensField ?? tokenLimitField(this.client)]: request.maxTokens }
        : {};
    const response = await this.client.chat.completions.create(
      {
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
        // Some upstreams reject a tool choice that has no tools to choose from.
        ...(request.toolChoice !== undefined && request.tools.length
          ? { tool_choice: toChatToolChoice(request.toolChoice) }
          : {}),
        ...providerOptions,
        ...limit,
        ...(request.outputType && request.outputType !== 'text'
          ? { response_format: toChatResponseFormat(request.outputType) }
          : {}),
      },
      // The OpenAI client accepts transport options separately from the JSON
      // body. Putting `signal` in the body silently left live HTTP streams
      // uncancellable.
      { signal: request.signal },
    );
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
    let upstreamProvider: string | undefined;
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
      if (this.dialect.reportsUpstreamProvider) {
        const reported = (chunk as any).provider;
        if (typeof reported === 'string' && reported.trim()) upstreamProvider = reported.trim();
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
            ...(current.id ? { callId: current.id } : {}),
            ...(typeof call.index === 'number' ? { callIndex: call.index } : {}),
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
    // Providers may omit tool call ids (or send ""). The fallback must be unique
    // per response: a positional `call_${index}` repeats in every response, and
    // anything keyed by call id (result pairing, approvals) then confuses calls.
    const fallbackIdPrefix = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}_`;
    for (const [index, call] of calls) if (!call.id) call.id = `${fallbackIdPrefix}${index}`;
    for (const [, call] of calls) yield { type: 'tool_call', id: call.id!, name: call.name, arguments: call.arguments };

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
        // Stamp the payload with the turn it belongs to. Replay cannot tell by
        // position alone: a turn without a payload followed by one with a
        // payload looks the same as one parallel batch split across items.
        item: { ...rawContinuityMetadata, [OPAQUE_TURN_TOOL_CALL_IDS_KEY]: [...calls.values()].map((c) => c.id!) },
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
        ...[...calls].map(([, call]) => ({
          type: 'tool_call' as const,
          id: call.id!,
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
      ...(upstreamProvider ? { providerMetadata: { provider: upstreamProvider } } : {}),
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
  const completionDetails =
    usage?.completion_tokens_details ?? usage?.output_tokens_details ?? usage?.outputTokensDetails;
  const cachedInputTokens =
    usage?.cached_tokens ?? usage?.cachedTokens ?? details?.cached_tokens ?? details?.cachedTokens;
  const cacheWriteTokens =
    usage?.cache_write_tokens ??
    usage?.cacheWriteTokens ??
    usage?.cache_creation_input_tokens ??
    usage?.cache_creation_tokens ??
    details?.cache_write_tokens ??
    details?.cacheWriteTokens;
  const reasoningTokens =
    usage?.reasoning_tokens ??
    usage?.reasoningTokens ??
    completionDetails?.reasoning_tokens ??
    completionDetails?.reasoningTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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
