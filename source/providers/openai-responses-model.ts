import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelTurnRequest,
  StreamedModelUsage,
  StreamedModelProviderOptions,
} from '../contracts/streamed-model-turn.js';
import type { ProviderRequestCapture } from './provider-request-capture.js';
import { consumeOpenAIRequestPrefixBindingWithOutcome } from './openai-request-prefix-binding.js';
import { observeOpenAIRequestLifecycle, type OpenAIRequestLifecycleObservation } from './provider-request-capture.js';
import { randomUUID } from 'node:crypto';
import { ResponsesWS } from 'openai/resources/responses/ws';

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

function toResponsesApiInput(input: readonly StreamedModelTurnInput[]): unknown[] {
  return input.map((item: any) => {
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
      const metadata = item.providerMetadata?.openai;
      const legacyEncryptedContent = item.providerMetadata?.encrypted_content;
      const encryptedContent = metadata?.encrypted_content ?? legacyEncryptedContent;
      return {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        summary: item.text ? [{ type: 'summary_text', text: item.text }] : [],
        ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
      };
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

function requestBody(request: StreamedModelTurnRequest, model: string, stream: boolean): any {
  const providerOptions = request.providerOptions ?? {};
  const extraBody = (providerOptions as any).extraBody;
  const projectedInput = toResponsesApiInput(request.input);
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
    ...(extraBody ?? {}),
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

function reasoningMetadata(item: any): StreamedModelProviderOptions | undefined {
  const directMetadata = item?.providerData ?? item?.provider_metadata ?? item?.provider_data;
  const nestedOpenAI = directMetadata?.openai;
  const encryptedContent =
    item?.encrypted_content ?? nestedOpenAI?.encrypted_content ?? directMetadata?.encrypted_content;
  if (encryptedContent === undefined) return undefined;
  return { openai: { encrypted_content: encryptedContent } };
}

function toTurnOutput(item: any): StreamedModelTurnOutput {
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
    const providerMetadata = reasoningMetadata(item);
    return {
      type: 'reasoning',
      ...(item.id ? { id: String(item.id) } : {}),
      text: reasoningText(item),
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }
  throw new Error(`Unsupported OpenAI Responses output item: ${String(item?.type ?? 'unknown')}`);
}

function responseStatusError(status: 'failed' | 'incomplete', response: any): Error {
  const providerError = response?.error;
  const detail = providerError?.message ?? providerError?.code ?? response?.status;
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

function completedEvent(response: any): Extract<StreamedModelTurnEvent, { type: 'completion' }> {
  return {
    type: 'completion',
    responseId: response?.id ?? response?.responseId ?? `response-${Date.now()}`,
    output: (response?.output ?? []).map(toTurnOutput),
    usage: normalizeUsage(response?.usage),
    ...(response?.status ? { finishReason: response.status } : {}),
  };
}

/** Convert one native OpenAI Responses event to the application turn protocol. */
export function normalizeResponseEvent(event: any): StreamedModelTurnEvent | null {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'response.output_text.delta') return { type: 'text_delta', text: event.delta ?? '' };
  if (event.type === 'response.reasoning_summary_text.delta') {
    return { type: 'reasoning_delta', id: event.item_id, text: event.delta ?? '' };
  }
  if (event.type === 'response.failed' || event.type === 'response.incomplete') {
    const response = event.response ?? event;
    throw responseStatusError(event.type === 'response.failed' ? 'failed' : 'incomplete', {
      ...response,
      ...(event.error && !response.error ? { error: event.error } : {}),
    });
  }
  if (event.type === 'response.completed') return completedEvent(event.response ?? event);
  return null;
}

export class OpenAIResponsesModelWithPromptCacheKey implements StreamedModelTurn {
  protected readonly lifecycle = new Lifecycle();

  constructor(
    protected readonly _client: any,
    protected readonly _model: string,
    protected readonly capture?: ProviderRequestCapture,
  ) {}

  async getResponse(request: StreamedModelTurnRequest): Promise<any> {
    this.lifecycle.begin(request, 'http', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    try {
      const response = await this._client.responses.create(requestBody(request, this._model, false), {
        ...(request.signal ? { signal: request.signal } : {}),
        ...((request.providerOptions as any)?.extraHeaders
          ? { headers: (request.providerOptions as any).extraHeaders }
          : {}),
      });
      assertUnaryResponseCompleted(response);
      const completion = completedEvent(response);
      this.lifecycle.finish(request, 'terminal', this.capture, completion.responseId);
      return completion;
    } catch (error) {
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
      const source = await this._client.responses.create(requestBody(request, this._model, true), {
        ...(request.signal ? { signal: request.signal } : {}),
        ...((request.providerOptions as any)?.extraHeaders
          ? { headers: (request.providerOptions as any).extraHeaders }
          : {}),
      });
      for await (const event of source) {
        const normalized = normalizeResponseEvent(event);
        if (normalized?.type === 'completion') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
        }
        if (normalized) yield normalized;
      }
      if (!terminal) throw new Error('OpenAI streamed response ended without a completion.');
    } catch (error) {
      if (!terminal) this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finish(request, 'abandoned', this.capture);
    }
  }
}

export class OpenAIResponsesWSModelWithPromptCacheKey extends OpenAIResponsesModelWithPromptCacheKey {
  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    this.lifecycle.begin(request, 'websocket', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    const headers = (request.providerOptions as any)?.extraHeaders;
    const socket = new ResponsesWS(this._client, headers ? { headers } : undefined);
    let terminal = false;
    try {
      socket.send({ type: 'response.create', ...requestBody(request, this._model, true) } as any);
      for await (const message of socket.stream()) {
        if (message.type === 'error') throw (message as any).error ?? new Error('OpenAI WebSocket provider error');
        if (message.type === 'close') throw new Error('OpenAI WebSocket closed before a terminal response event.');
        if (message.type !== 'message') continue;
        const normalized = normalizeResponseEvent(message.message);
        if (normalized?.type === 'completion') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.responseId);
        }
        if (normalized) yield normalized;
        if (terminal) break;
      }
      if (!terminal) throw new Error('OpenAI WebSocket closed before a terminal response event.');
    } catch (error) {
      if (!terminal) this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finish(request, 'abandoned', this.capture);
      try {
        socket.close();
      } catch {
        /* best effort */
      }
    }
  }
}
