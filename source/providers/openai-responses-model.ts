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
  begin(request: any, transport: 'http' | 'websocket', model: string, client: any): void {
    if (request && typeof request === 'object')
      this.#attempts.set(request, {
        token: randomUUID(),
        provider: 'openai',
        transport,
        model,
        endpoint: endpointOf(client),
        requestData: {},
      });
  }
  bind(request: any, capture?: ProviderRequestCapture): void {
    const attempt = request && typeof request === 'object' ? this.#attempts.get(request) : undefined;
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
    request: any,
    phase: 'terminal' | 'failed' | 'abandoned',
    capture?: ProviderRequestCapture,
    responseId?: string,
  ): void {
    if (!request || typeof request !== 'object') return;
    const attempt = this.#attempts.get(request);
    if (!attempt) return;
    this.#attempts.delete(request);
    observeOpenAIRequestLifecycle(capture, { ...attempt, phase, ...(responseId ? { responseId } : {}) });
  }
}

// `bridgeBackToTurn` (agents-model-bridge.ts) passes StreamedModelTurnInput items
// straight through except renaming `tool_result` -> `function_call_result`. Those
// items use the app-internal generic shapes (`{type:'text'}` content parts,
// `{type:'tool_call', id, name, arguments}`), not the Responses API's own item
// types (`input_text`/`output_text`, `function_call`/`function_call_output`). The
// API rejects unrecognized types outright, so every real request needs this
// translation — without it, every openai-provider turn fails with a 400.
function toResponsesApiContentPart(role: string, part: any): any {
  if (part?.type === 'image') {
    const image = part.image;
    const url = typeof image === 'string' ? image : image?.id;
    return { type: 'input_image', image_url: url, detail: part.detail ?? 'auto' };
  }
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part?.text ?? '' };
}

function toResponsesApiOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  const text = (output as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : JSON.stringify(output ?? '');
}

function toResponsesApiInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
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
    if (item?.type === 'function_call_result') {
      return {
        type: 'function_call_output',
        call_id: item.callId ?? item.call_id,
        output: toResponsesApiOutput(item.output),
      };
    }
    if (item?.type === 'reasoning') {
      return {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        content: item.text ? [{ type: 'reasoning_text', text: item.text }] : [],
      };
    }
    return item;
  });
}

function requestBody(request: any, model: string, stream: boolean): any {
  const settings = request?.modelSettings ?? {};
  const providerData = settings.providerData ?? {};
  const body: any = {
    model,
    input:
      typeof request?.input === 'string'
        ? [{ role: 'user', content: request.input }]
        : toResponsesApiInput(request?.input ?? []),
    stream,
    ...(request?.systemInstructions ? { instructions: request.systemInstructions } : {}),
    ...(Array.isArray(request?.tools) ? { tools: request.tools } : {}),
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
    ...(request?.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
    ...(providerData.extraBody ?? {}),
  };
  return body;
}

function responseShape(response: any): any {
  return {
    usage: response?.usage,
    output: response?.output ?? [],
    responseId: response?.id ?? response?.responseId,
    providerData: response,
  };
}

export class OpenAIResponsesModelWithPromptCacheKey {
  readonly _model: string;
  readonly _client: any;
  protected readonly lifecycle = new Lifecycle();
  constructor(client: any, model: string, protected readonly capture?: ProviderRequestCapture) {
    this._client = client;
    this._model = model;
  }
  async getResponse(request: any): Promise<any> {
    this.lifecycle.begin(request, 'http', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    try {
      const response = await this._client.responses.create(requestBody(request, this._model, false));
      const result = responseShape(response);
      this.lifecycle.finish(request, 'terminal', this.capture, result.responseId);
      return result;
    } catch (error) {
      this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    }
  }
  async *getStreamedResponse(request: any): AsyncIterable<any> {
    this.lifecycle.begin(request, 'http', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    let terminal = false;
    try {
      const source = await this._client.responses.create(requestBody(request, this._model, true));
      for await (const event of source) {
        const normalized = normalizeResponseEvent(event);
        if (normalized?.type === 'response_done') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.response?.id);
        }
        if (normalized) yield normalized;
      }
    } catch (error) {
      terminal = true;
      this.lifecycle.finish(request, 'failed', this.capture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finish(request, 'abandoned', this.capture);
    }
  }
}

export class OpenAIResponsesWSModelWithPromptCacheKey extends OpenAIResponsesModelWithPromptCacheKey {
  async *getStreamedResponse(request: any): AsyncIterable<any> {
    this.lifecycle.begin(request, 'websocket', this._model, this._client);
    this.lifecycle.bind(request, this.capture);
    const requestData = requestBody(request, this._model, true);
    const headers = request?.modelSettings?.providerData?.extraHeaders;
    const socket = new ResponsesWS(this._client, headers ? { headers } : undefined);
    socket.send({ type: 'response.create', ...requestData } as any);
    let terminal = false;
    try {
      for await (const message of socket.stream()) {
        if (message.type === 'error') {
          throw (message as any).error ?? new Error('OpenAI WebSocket provider error');
        }
        if (message.type === 'close') {
          throw new Error('OpenAI WebSocket closed before a terminal response event.');
        }
        if (message.type !== 'message') continue;
        const normalized = normalizeResponseEvent(message.message);
        if (normalized?.type === 'response_done') {
          terminal = true;
          this.lifecycle.finish(request, 'terminal', this.capture, normalized.response?.id);
        }
        if (normalized) yield normalized;
        if (terminal) break;
      }
    } catch (error) {
      terminal = true;
      this.lifecycle.finish(request, 'failed', this.capture);
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

export function normalizeResponseEvent(event: any): any {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'response.output_text.delta') return { type: 'output_text_delta', delta: event.delta ?? '' };
  if (event.type === 'response.reasoning_summary_text.delta') return { type: 'model', event };
  if (event.type === 'response.output_item.done') return { type: 'model', event };
  if (event.type === 'response.failed' || event.type === 'response.incomplete') {
    const response = event.response ?? event;
    const providerError = response.error ?? event.error;
    const detail = providerError?.message ?? providerError?.code ?? response.status;
    throw new Error(
      `OpenAI response ${event.type}${detail ? ` (${String(detail)})` : ''}${response.id ? ` [${response.id}]` : ''}`,
    );
  }
  if (event.type === 'response.completed') {
    return { type: 'response_done', response: event.response ?? event };
  }
  return event.type === 'response.created' ? { type: 'response_started' } : event;
}
