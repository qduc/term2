import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelTurnRequest,
  StreamedModelUsage,
  StreamedModelProviderOptions,
  ContextCompactionSessionState,
} from '../contracts/streamed-model-turn.js';
import type { ProviderRequestCapture } from './provider-request-capture.js';
import { OPENAI_RESPONSES_OPAQUE_TAG, isForeignProviderOpaque } from './provider-opaque-compatibility.js';
import { consumeOpenAIRequestPrefixBindingWithOutcome } from './openai-request-prefix-binding.js';
import { observeOpenAIRequestLifecycle, type OpenAIRequestLifecycleObservation } from './provider-request-capture.js';
import { randomUUID } from 'node:crypto';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { getModelContextWindow } from './model-catalog/catalog.js';
import { ResponsesWebSocketSessions } from './responses-websocket-sessions.js';
import { WebSocketClosedEarlyError, readWebSocketCloseFrame } from './websocket-close-evidence.js';

const endpointOf = (client: any): string => {
  const value = client?.baseURL ?? client?._options?.baseURL;
  return typeof value === 'string' && value ? value.replace(/\/$/, '') : 'https://api.openai.com/v1';
};

type Attempt = Omit<OpenAIRequestLifecycleObservation, 'phase' | 'responseId'>;

class Lifecycle {
  #attempts = new WeakMap<object, Attempt>();

  begin(request: StreamedModelTurnRequest, transport: 'http' | 'websocket', model: string, client: any): void {
    this.#attempts.set(request as object, {
      token: randomUUID(),
      provider: 'openai',
      transport,
      model,
      endpoint: endpointOf(client),
      requestData: {},
    });
  }

  bind(request: StreamedModelTurnRequest, capture?: ProviderRequestCapture): void {
    const attempt = this.#attempts.get(request as object);
    if (!attempt) return;
    try {
      attempt.requestData = { input: structuredClone(request.input) };
      const binding = consumeOpenAIRequestPrefixBindingWithOutcome(request.input);
      attempt.prefixBinding = binding.binding;
      attempt.prefixBindingOutcome = binding.outcome;
      observeOpenAIRequestLifecycle(capture, { ...attempt, phase: 'request-built' });
    } catch {
      /* lifecycle observation is non-authoritative */
    }
  }

  finish(
    request: StreamedModelTurnRequest,
    phase: 'terminal' | 'failed' | 'abandoned',
    capture?: ProviderRequestCapture,
    responseId?: string,
  ): void {
    const attempt = this.#attempts.get(request as object);
    if (!attempt) return;
    this.#attempts.delete(request as object);
    observeOpenAIRequestLifecycle(capture, { ...attempt, phase, ...(responseId ? { responseId } : {}) });
  }
}

function toResponsesApiContentPart(role: string, part: any): any {
  if (part?.type === 'image') {
    const image = part.image;
    const url = typeof image === 'string' ? image : image?.id ?? image?.url;
    return { type: 'input_image', image_url: url, detail: part.detail ?? 'auto' };
  }
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part?.text ?? '' };
}

function toResponsesApiOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  // Tool execution historically supplied structured values. Keep the
  // application result wrapped under `text` when serializing those values so
  // continuation requests remain byte-for-byte compatible with the old wire
  // projection while typed string results stay plain text.
  return JSON.stringify({ text: output ?? '' });
}

function toResponsesApiInput(
  input: readonly StreamedModelTurnInput[],
  lane: string = OPENAI_RESPONSES_OPAQUE_TAG,
): unknown[] {
  // An opaque item from another lane is inert baggage left by a provider
  // switch, not a fault: it is dropped so the rest of the history still
  // replays. See `provider-opaque-compatibility.ts`.
  const replayable = input.filter((item) => !isForeignProviderOpaque(item, lane));
  return replayable.map((item: any) => {
    if (item?.type === 'message') {
      return {
        type: 'message',
        role: item.role,
        content:
          typeof item.content === 'string'
            ? item.content
            : (item.content ?? []).map((part: any) => toResponsesApiContentPart(item.role, part)),
      };
    }
    if (item?.type === 'tool_call') {
      return { type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments };
    }
    if (item?.type === 'tool_result') {
      return { type: 'function_call_output', call_id: item.id, output: toResponsesApiOutput(item.output) };
    }
    if (item?.type === 'reasoning') {
      // Read only this lane's key: a sibling lane's blob is another vendor's
      // ciphertext, and sending it would fail the turn.
      const metadata = item.providerMetadata?.[lane];
      const legacyEncryptedContent =
        lane === OPENAI_RESPONSES_OPAQUE_TAG ? item.providerMetadata?.encrypted_content : undefined;
      const encryptedContent = metadata?.encrypted_content ?? legacyEncryptedContent;
      return {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        summary: item.text ? [{ type: 'summary_text', text: item.text }] : [],
        ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
      };
    }
    if (item?.type === 'provider_opaque') {
      // Foreign tags were filtered above; anything reaching here is our own.
      return item.item;
    }
    return item;
  });
}

function toResponsesToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>): unknown {
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}

function toResponsesOutputFormat(
  outputType: Exclude<NonNullable<StreamedModelTurnRequest['outputType']>, 'text'>,
): any {
  return {
    format: {
      type: 'json_schema',
      name: outputType.name,
      strict: outputType.strict,
      schema: outputType.schema,
    },
  };
}

/** Shared allowlist for Responses `context_management` (OpenAI + Codex). */
export function supportsContextCompactionModel(model: string): boolean {
  // Server-side context_management is model-dependent: gpt-5.1/gpt-5.2 returned
  // opaque 500s when the threshold fired (docs/plans/openai-context-compaction.md).
  // OpenAI's compaction guide demos gpt-5.3-codex; the compact endpoint enum and
  // product usage cover gpt-5.5 and the full gpt-5.6 family (sol/terra/luna).
  // Default-deny unmeasured families (e.g. bare gpt-5.3, gpt-5.10).
  // Re-measure before adding a new family.
  return /^(?:gpt-5\.(?:4|5|6)(?:$|[-_])|gpt-5\.3-codex(?:$|[-_]))/.test(model);
}

function contextCompaction(
  providerOptions: StreamedModelProviderOptions | undefined,
  model: string,
  providerSupportsContextCompaction: boolean,
  sessionState?: ContextCompactionSessionState,
): { threshold: number } | undefined {
  if (sessionState?.disabled || !providerSupportsContextCompaction || !supportsContextCompactionModel(model))
    return undefined;
  const option = (providerOptions as any)?.contextCompaction;
  if (
    option?.enabled !== true ||
    typeof option.threshold !== 'number' ||
    !Number.isFinite(option.threshold) ||
    option.threshold < 0 ||
    option.threshold > 1
  ) {
    return undefined;
  }
  // Catalog keys are shared across OpenAI and Codex model ids.
  const contextWindow = getModelContextWindow('openai', model) ?? getModelContextWindow('codex', model);
  if (!contextWindow) return undefined;

  // The setting is a fraction of the selected model's context window. The
  // Responses API still accepts an integer token count and enforces a 1000
  // token minimum, so apply that provider-specific conversion at the wire
  // boundary rather than exposing model-specific token counts in settings.
  const ratioThreshold = Math.max(1000, Math.round(contextWindow * option.threshold));
  const thresholdTokens =
    typeof option.thresholdTokens === 'number' &&
    Number.isInteger(option.thresholdTokens) &&
    option.thresholdTokens >= 1000
      ? option.thresholdTokens
      : undefined;
  return { threshold: thresholdTokens === undefined ? ratioThreshold : Math.min(ratioThreshold, thresholdTokens) };
}

/** Wire shape for `context_management`, or undefined when gated off. */
export function resolveContextManagement(
  providerOptions: StreamedModelProviderOptions | undefined,
  model: string,
  providerSupportsContextCompaction: boolean,
  sessionState?: ContextCompactionSessionState,
): Array<{ type: 'compaction'; compact_threshold: number }> | undefined {
  const compaction = contextCompaction(providerOptions, model, providerSupportsContextCompaction, sessionState);
  if (!compaction) return undefined;
  return [{ type: 'compaction', compact_threshold: compaction.threshold }];
}

function requestBody(
  request: StreamedModelTurnRequest,
  model: string,
  stream: boolean,
  providerSupportsContextCompaction = false,
  sessionState?: ContextCompactionSessionState,
  lane: string = OPENAI_RESPONSES_OPAQUE_TAG,
): any {
  const providerOptions = request.providerOptions ?? {};
  // context_management is capability-gated below. Do not let the generic
  // extra-body escape hatch bypass that gate on unsupported endpoints/models.
  const { context_management: _reservedContextManagement, ...extraBody } = (providerOptions as any).extraBody ?? {};
  const contextManagement = resolveContextManagement(
    providerOptions,
    model,
    providerSupportsContextCompaction,
    sessionState,
  );
  const projectedInput = toResponsesApiInput(request.input, lane);
  const body = {
    model,
    input: projectedInput,
    stream,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    ...((request.tools ?? []).length
      ? { tools: (request.tools ?? []).map((tool) => ({ type: 'function', ...tool })) }
      : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: toResponsesToolChoice(request.toolChoice) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
    ...(request.outputType && request.outputType !== 'text'
      ? { text: toResponsesOutputFormat(request.outputType) }
      : {}),
    ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
    ...extraBody,
    ...(contextManagement ? { context_management: contextManagement } : {}),
  } as any;

  // Encrypted reasoning is only returned when explicitly requested by the
  // Responses API. Merge this provider requirement with caller/extra-body
  // includes rather than replacing or duplicating either source.
  const existingInclude = [body.include, (providerOptions as any).include].filter(Array.isArray).flat() as unknown[];
  body.include = Array.from(new Set([...existingInclude, 'reasoning.encrypted_content']));
  return body;
}

function normalizeUsage(usage: any): StreamedModelUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? usage.inputTokens;
  const outputTokens = usage.output_tokens ?? usage.outputTokens;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens ?? usage.cachedInputTokens;
  const cacheWriteTokens = usage.input_tokens_details?.cache_creation_tokens ?? usage.cacheWriteTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function reasoningText(item: any): string {
  const summary = item?.summary ?? item?.content ?? item?.rawContent;
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary
    .filter((part: any) => part?.type === 'summary_text' || part?.type === 'reasoning_text' || part?.type === 'text')
    .map((part: any) => String(part.text ?? ''))
    .join('');
}

function reasoningMetadata(item: any, lane: string): StreamedModelProviderOptions | undefined {
  const directMetadata = item?.providerData ?? item?.provider_metadata ?? item?.provider_data;
  const nested = directMetadata?.[lane];
  const encryptedContent = item?.encrypted_content ?? nested?.encrypted_content ?? directMetadata?.encrypted_content;
  if (encryptedContent === undefined) return undefined;
  return { [lane]: { encrypted_content: encryptedContent } };
}

function toTurnOutput(item: any, lane: string = OPENAI_RESPONSES_OPAQUE_TAG): StreamedModelTurnOutput {
  if (item?.type === 'function_call') {
    return {
      type: 'tool_call',
      id: item.call_id ?? item.callId,
      name: item.name,
      arguments: item.arguments ?? '{}',
    };
  }
  if (item?.type === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    return {
      type: 'message',
      content: content
        .filter((part: any) => part?.type === 'output_text' || part?.type === 'text')
        .map((part: any) => ({ type: 'text' as const, text: String(part.text ?? '') })),
    };
  }
  if (item?.type === 'reasoning') {
    const providerMetadata = reasoningMetadata(item, lane);
    return {
      type: 'reasoning',
      ...(item.id ? { id: String(item.id) } : {}),
      text: reasoningText(item),
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }
  // Anything else is provider-native and opaque: carry it through untouched
  // rather than failing the turn. Compaction items are the first such type;
  // future Responses item kinds flow the same way.
  return {
    type: 'provider_opaque',
    provider: lane,
    item,
  };
}

export type ContextCompactionFailureCategory = 'request' | 'validation';

export function contextCompactionFailureCategory(error: unknown): ContextCompactionFailureCategory | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const status = Number(record.status ?? record.statusCode ?? (record.error as any)?.status);
  const text = JSON.stringify(error);
  if (status === 500 && /context[_ ]management|server_error/i.test(text)) return 'request';
  if (status === 400 && /unsupported_value/i.test(text) && /context[_ ]management/i.test(text)) return 'request';
  if (status === 400 && /integer_below_min_value|compact_threshold|context[_ ]management/i.test(text))
    return 'validation';
  return undefined;
}

export function markContextCompactionFailure(
  error: unknown,
  request: StreamedModelTurnRequest,
  sessionState?: ContextCompactionSessionState,
): void {
  if (!request.providerOptions || !(request.providerOptions as any).contextCompaction) return;
  const category = contextCompactionFailureCategory(error);
  if (!category) return;
  if (category === 'request' && sessionState) sessionState.disabled = true;
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'contextCompactionFailure', { value: category, configurable: true });
  }
}

function responseStatusError(status: 'failed' | 'incomplete', response: any): Error {
  const providerError = response?.error;
  const detail =
    providerError?.message ??
    providerError?.code ??
    response?.incomplete_details?.reason ??
    response?.incompleteDetails?.reason ??
    response?.status;
  return new Error(
    `OpenAI response response.${status}${detail ? ` (${String(detail)})` : ''}${
      response?.id ? ` [${response.id}]` : ''
    }`,
  );
}

function assertUnaryResponseCompleted(response: any): void {
  if (response?.status === 'failed' || response?.status === 'incomplete') {
    throw responseStatusError(response.status, response);
  }
}

function completedEvent(
  response: any,
  lane: string = OPENAI_RESPONSES_OPAQUE_TAG,
): Extract<StreamedModelTurnEvent, { type: 'completion' }> {
  return {
    type: 'completion',
    responseId: response?.id ?? response?.responseId ?? `response-${Date.now()}`,
    output: (response?.output ?? []).map((item: any) => toTurnOutput(item, lane)),
    usage: normalizeUsage(response?.usage),
    ...(response?.status ? { finishReason: response.status } : {}),
  };
}

/** State needed to turn provider tool-argument fragments into UI progress events. */
export interface ResponseEventNormalizationState {
  toolNamesByIndex: Map<number | string, string>;
  toolArgumentLengthsByIndex: Map<number | string, number>;
  /** Reasoning items already surfaced so a full-text summary part is not re-emitted. */
  reasoningEmittedItemIds: Set<string>;
  /**
   * Wall-clock start of each in-flight compaction item, keyed by output index.
   * The elapsed time between the provider's `added` and `done` frames is the only
   * real measurement of how long compaction took; nothing downstream can recover it.
   */
  compactionStartedAtByIndex: Map<number | string, number>;
}

export function createResponseEventNormalizationState(): ResponseEventNormalizationState {
  return {
    toolNamesByIndex: new Map(),
    toolArgumentLengthsByIndex: new Map(),
    reasoningEmittedItemIds: new Set(),
    compactionStartedAtByIndex: new Map(),
  };
}

/**
 * Pairing key for a compaction item's `added`/`done` frames. A response carries more than
 * one compaction item, so the key must distinguish them: `output_index` does, and the item
 * id is the fallback for shims that omit it.
 */
function compactionIndex(event: any, item: any): number | string {
  if (typeof event.output_index === 'number') return event.output_index;
  return typeof item?.id === 'string' ? item.id : 0;
}

/** Convert one native OpenAI Responses event to the application turn protocol. */
export function normalizeResponseEvent(
  event: any,
  state: ResponseEventNormalizationState = createResponseEventNormalizationState(),
  lane: string = OPENAI_RESPONSES_OPAQUE_TAG,
): StreamedModelTurnEvent | null {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'response.output_text.delta') return { type: 'text_delta', text: event.delta ?? '' };
  const reasoningDelta = (id: string | undefined, text: string): StreamedModelTurnEvent | null => {
    if (!text) return null;
    if (id !== undefined) state.reasoningEmittedItemIds.add(id);
    return { type: 'reasoning_delta', ...(id !== undefined ? { id } : {}), text };
  };
  // OpenAI-compatible servers emit reasoning under a few different delta names.
  // opencode's /v1/responses shim streams response.reasoning_text.delta while
  // OpenAI's own Responses API uses response.reasoning_summary_text.delta.
  if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
    return reasoningDelta(event.item_id, String(event.delta ?? ''));
  }
  // Summary parts carry the reasoning text in part.text. Added/delta events are
  // incremental; done can repeat the complete text, so only emit it when no
  // earlier part for the item was observed.
  if (
    event.type === 'response.reasoning_summary_part.added' ||
    event.type === 'response.reasoning_summary_part.delta'
  ) {
    const text = typeof event.part?.text === 'string' ? event.part.text : '';
    const id = typeof event.item_id === 'string' ? event.item_id : undefined;
    return reasoningDelta(id, text);
  }
  if (event.type === 'response.reasoning_summary_part.done') {
    const text = typeof event.part?.text === 'string' ? event.part.text : '';
    const id = typeof event.item_id === 'string' ? event.item_id : undefined;
    if (!text || (id !== undefined && state.reasoningEmittedItemIds.has(id))) return null;
    return reasoningDelta(id, text);
  }
  if (event.type === 'response.output_item.added') {
    const item = event.output_item ?? event.item;
    if (item?.type === 'function_call' && typeof item.name === 'string') {
      const index = typeof event.output_index === 'number' ? event.output_index : item.id ?? 0;
      state.toolNamesByIndex.set(index, item.name);
      state.toolArgumentLengthsByIndex.set(index, 0);
      if (typeof item.id === 'string') {
        state.toolNamesByIndex.set(item.id, item.name);
        state.toolArgumentLengthsByIndex.set(item.id, 0);
      }
    }
    if (item?.type === 'compaction') {
      state.compactionStartedAtByIndex.set(compactionIndex(event, item), Date.now());
      return { type: 'context_compaction_started', provider: 'openai' };
    }
    return null;
  }
  if (
    event.type === 'response.function_call_arguments.delta' ||
    event.type === 'response.custom_tool_call_input.delta' ||
    event.type === 'response.mcp_call_arguments.delta'
  ) {
    const index = typeof event.output_index === 'number' ? event.output_index : event.item_id ?? 0;
    const delta = typeof event.delta === 'string' ? event.delta : '';
    if (!delta) return null;
    const argumentCharCount = (state.toolArgumentLengthsByIndex.get(index) ?? 0) + delta.length;
    state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
    const toolName = state.toolNamesByIndex.get(index);
    return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
  }
  // opencode may deliver the assembled arguments only on the done frames rather
  // than as incremental deltas. Surface the full count so the UI still shows the
  // "Calling <tool> (N chars)" indicator before tool_started replaces it.
  if (
    event.type === 'response.function_call_arguments.done' ||
    event.type === 'response.custom_tool_call_input.done' ||
    event.type === 'response.mcp_call_arguments.done'
  ) {
    const index = typeof event.output_index === 'number' ? event.output_index : event.item_id ?? 0;
    const fullArguments = typeof event.arguments === 'string' ? event.arguments : '';
    const previousLength = state.toolArgumentLengthsByIndex.get(index) ?? 0;
    const argumentCharCount = fullArguments.length || previousLength;
    if (argumentCharCount <= previousLength) return null;
    state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
    const toolName = state.toolNamesByIndex.get(index);
    return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
  }
  if (event.type === 'response.output_item.delta') {
    const delta = event.delta;
    const argumentsText = typeof delta?.arguments === 'string' ? delta.arguments : '';
    if (!argumentsText) return null;
    const index = typeof event.output_index === 'number' ? event.output_index : 0;
    const argumentCharCount = (state.toolArgumentLengthsByIndex.get(index) ?? 0) + argumentsText.length;
    state.toolArgumentLengthsByIndex.set(index, argumentCharCount);
    const toolName = state.toolNamesByIndex.get(index);
    return { type: 'tool_call_streaming_delta', ...(toolName ? { toolName } : {}), argumentCharCount };
  }
  if (event.type === 'response.output_item.done') {
    const item = event.item;
    if (item?.type === 'function_call') {
      const index = typeof event.output_index === 'number' ? event.output_index : item.id ?? item.call_id ?? 0;
      if (typeof item.name === 'string') state.toolNamesByIndex.set(index, item.name);
      const fullArguments = typeof item.arguments === 'string' ? item.arguments : '';
      const previousLength = Math.max(
        state.toolArgumentLengthsByIndex.get(index) ?? 0,
        typeof item.id === 'string' ? state.toolArgumentLengthsByIndex.get(item.id) ?? 0 : 0,
        typeof item.call_id === 'string' ? state.toolArgumentLengthsByIndex.get(item.call_id) ?? 0 : 0,
      );
      if (fullArguments.length <= previousLength) return null;
      state.toolArgumentLengthsByIndex.set(index, fullArguments.length);
      return {
        type: 'tool_call_streaming_delta',
        ...(typeof item.name === 'string' ? { toolName: item.name } : {}),
        argumentCharCount: fullArguments.length,
      };
    }
    if (item?.type === 'compaction') {
      const key = compactionIndex(event, item);
      const startedAt = state.compactionStartedAtByIndex.get(key);
      state.compactionStartedAtByIndex.delete(key);
      // A `done` without a matching `added` would mean an unpaired frame; report 0 rather
      // than inventing an interval from an unrelated clock reading.
      return {
        type: 'context_compaction_completed',
        provider: lane,
        durationMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
      };
    }
    return null;
  }
  if (event.type === 'response.failed' || event.type === 'response.incomplete') {
    const response = event.response ?? event;
    throw responseStatusError(event.type === 'response.failed' ? 'failed' : 'incomplete', {
      ...response,
      ...(event.error && !response.error ? { error: event.error } : {}),
    });
  }
  if (event.type === 'response.completed') return completedEvent(event.response ?? event, lane);
  return null;
}

export class OpenAIResponsesModelWithPromptCacheKey implements StreamedModelTurn {
  protected readonly lifecycle = new Lifecycle();
  protected readonly _client: any;
  protected readonly _model: string;
  protected readonly capture?: ProviderRequestCapture;
  protected readonly supportsContextCompaction: boolean;
  protected readonly contextCompactionSessionState?: ContextCompactionSessionState;
  /**
   * Which opaque lane this adapter's items belong to. Defaults to the OpenAI
   * lane; Grok speaks the same wire shape but is a different vendor, so its
   * encrypted reasoning must not cross into an OpenAI request.
   */
  protected readonly lane: string;

  constructor(
    _client: any,
    _model: string,
    capture?: ProviderRequestCapture,
    supportsContextCompaction = false,
    contextCompactionSessionState?: ContextCompactionSessionState,
    lane: string = OPENAI_RESPONSES_OPAQUE_TAG,
  ) {
    this._client = _client;
    this._model = _model.trim();
    this.capture = capture;
    this.supportsContextCompaction = supportsContextCompaction;
    this.contextCompactionSessionState = contextCompactionSessionState;
    this.lane = lane;
  }

  async getResponse(
    request: StreamedModelTurnRequest,
  ): Promise<Extract<StreamedModelTurnEvent, { type: 'completion' }>> {
    this.lifecycle.begin(request, 'http', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    try {
      const response = await this._client.responses.create(
        requestBody(
          request,
          this._model,
          false,
          this.supportsContextCompaction,
          this.contextCompactionSessionState,
          this.lane,
        ),
        {
          ...(request.signal ? { signal: request.signal } : {}),
          ...((request.providerOptions as any)?.extraHeaders
            ? { headers: (request.providerOptions as any).extraHeaders }
            : {}),
        },
      );
      assertUnaryResponseCompleted(response);
      const completion = completedEvent(response, this.lane);
      this.lifecycle.finish(request, 'terminal', this.capture, completion.responseId);
      return completion;
    } catch (error) {
      markContextCompactionFailure(error, request, this.contextCompactionSessionState);
      this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    }
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    yield* this.#streamHttp(request);
  }

  async *#streamHttp(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    this.lifecycle.begin(request, 'http', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    let terminal = false;
    try {
      const source = await this._client.responses.create(
        requestBody(
          request,
          this._model,
          true,
          this.supportsContextCompaction,
          this.contextCompactionSessionState,
          this.lane,
        ),
        {
          ...(request.signal ? { signal: request.signal } : {}),
          ...((request.providerOptions as any)?.extraHeaders
            ? { headers: (request.providerOptions as any).extraHeaders }
            : {}),
        },
      );
      const normalizationState = createResponseEventNormalizationState();
      for await (const event of source) {
        const normalized = normalizeResponseEvent(event, normalizationState, this.lane);
        if (normalized?.type === 'completion') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
        }
        if (normalized) yield normalized;
      }
      if (!terminal) throw new Error('OpenAI streamed response ended without a completion.');
    } catch (error) {
      markContextCompactionFailure(error, request, this.contextCompactionSessionState);
      if (!terminal) this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finish(request, 'abandoned', this.capture);
    }
  }
}

export class OpenAIResponsesWSModelWithPromptCacheKey extends OpenAIResponsesModelWithPromptCacheKey {
  #sessions = new ResponsesWebSocketSessions(
    (headers) => new ResponsesWS(this._client, headers ? { headers } : undefined),
  );

  async close(): Promise<void> {
    this.#sessions.close();
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    this.lifecycle.begin(request, 'websocket', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    const headers = (request.providerOptions as any)?.extraHeaders as Record<string, string> | undefined;
    const socket = this.#sessions.acquire(headers);

    let terminal = false;
    let iteratorFinished = false;
    let iterator: AsyncIterator<any> | undefined;
    let released = false;
    const release = (keepAlive: boolean) => {
      if (released) return;
      released = true;
      this.#sessions.release(socket, { keepAlive });
    };
    try {
      socket.send({
        type: 'response.create',
        ...requestBody(
          request,
          this._model,
          true,
          this.supportsContextCompaction,
          this.contextCompactionSessionState,
          this.lane,
        ),
      } as any);
      const normalizationState = createResponseEventNormalizationState();
      iterator = socket.stream()[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          iteratorFinished = true;
          break;
        }
        const message = next.value;
        if (message.type === 'error') throw (message as any).error ?? new Error('OpenAI WebSocket provider error');
        // This model never records a dispatch state, so a close is only ever
        // ambiguous here: capture the code, but never claim it was unsent.
        if (message.type === 'close') throw new WebSocketClosedEarlyError(readWebSocketCloseFrame(message));
        if (message.type !== 'message') continue;
        const normalized = normalizeResponseEvent(message.message, normalizationState, this.lane);
        if (normalized?.type === 'completion') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
        }
        if (normalized) yield normalized;
        if (terminal) return;
      }
      // The iterator ended with no close frame, so there is no close code to
      // read: an unexplained end is treated the same as an unexplained close.
      if (!terminal) throw new WebSocketClosedEarlyError({});
    } catch (error) {
      release(false);
      markContextCompactionFailure(error, request, this.contextCompactionSessionState);
      if (!terminal) this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    } finally {
      if (iterator && !iteratorFinished) {
        if (terminal) {
          // A terminal event ends one response, not the session-scoped socket.
          // Do not await an SDK iterator return that waits for socket closure.
          try {
            void iterator.return?.().catch(() => undefined);
          } catch {
            // Terminal settlement remains authoritative.
          }
        } else {
          await iterator.return?.();
        }
      }
      if (terminal) {
        release(true);
      } else {
        release(false);
        this.lifecycle.finish(request, 'abandoned', this.capture);
      }
    }
  }
}
