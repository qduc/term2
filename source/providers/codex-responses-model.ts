import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { getCurrentTrace, withTrace } from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import { describeError } from '../utils/error-helpers.js';
import { sanitizeHeaders } from '../utils/header-sanitizer.js';
import type { ILoggingService, ISessionContextService } from '../services/service-interfaces.js';

type TrafficLogger = Pick<ILoggingService, 'debug' | 'error' | 'getCorrelationId'>;

type DiagnosticLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

const SUSPICIOUS_RECONSTRUCTED_OUTPUT_ITEM_COUNT = 20;
const TERMINAL_RESPONSE_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.error',
]);

const WS_RESPONSE_MODEL_CLASS = 'OpenAIResponsesWSModel';
const WS_RESPONSE_WRAPPER_CLASS = 'CodexResponsesWSModel';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const CODEX_REPLAY_ITEM_TYPES_WITHOUT_IDS = new Set([
  'message',
  'reasoning',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'custom_tool_call',
  'web_search_call',
]);

function stripCodexReplayIds(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  let changed = false;
  const normalized = input.map((item) => {
    const record = asRecord(item);
    const type = stringValue(record?.type);
    if (!record || !type || !CODEX_REPLAY_ITEM_TYPES_WITHOUT_IDS.has(type) || !('id' in record)) {
      return item;
    }

    const { id: _id, ...rest } = record;
    changed = true;
    return rest;
  });

  return changed ? normalized : input;
}

function normalizeCodexRequestData(requestData: any, request: any): any {
  const normalizedRequestData = { ...requestData };

  // Codex responses endpoint rejects temperature; always omit it.
  if ('temperature' in normalizedRequestData) {
    delete normalizedRequestData.temperature;
  }

  normalizedRequestData.input = stripCodexReplayIds(normalizedRequestData.input);

  const modelInclude = request?.modelSettings?.include;
  if (Array.isArray(modelInclude) && modelInclude.length > 0) {
    const existingInclude = Array.isArray(normalizedRequestData.include) ? normalizedRequestData.include : [];
    normalizedRequestData.include = Array.from(
      new Set([...existingInclude, ...modelInclude].filter((entry) => typeof entry === 'string' && entry.length > 0)),
    );
  }

  const promptCacheKey = request?.modelSettings?.prompt_cache_key;
  if (typeof promptCacheKey === 'string' && promptCacheKey.length > 0) {
    normalizedRequestData.prompt_cache_key = promptCacheKey;
  }

  return normalizedRequestData;
}

const summarizeReconstructedItems = (items: unknown[]): Record<string, unknown> => {
  const typeCounts: Record<string, number> = {};
  let functionCallCount = 0;

  for (const item of items) {
    const record = asRecord(item);
    const type = stringValue(record?.type) ?? 'unknown';
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (type === 'function_call') {
      functionCallCount++;
    }
  }

  const first = asRecord(items[0]);
  const last = asRecord(items[items.length - 1]);
  return {
    itemCount: items.length,
    typeCounts,
    functionCallCount,
    firstItemType: stringValue(first?.type),
    firstItemId: stringValue(first?.id),
    firstItemCallId: stringValue(first?.call_id) ?? stringValue(first?.callId),
    lastItemType: stringValue(last?.type),
    lastItemId: stringValue(last?.id),
    lastItemCallId: stringValue(last?.call_id) ?? stringValue(last?.callId),
  };
};

const summarizeWebsocketResponse = (response: unknown): Record<string, unknown> => {
  const record = asRecord(response) ?? {};
  const output = Array.isArray(record.output) ? record.output : [];
  const outputTypes = output
    .map((item) => stringValue(asRecord(item)?.type) ?? 'unknown')
    .filter((type, index, array) => array.indexOf(type) === index);
  const firstMessage = output.find((item) => stringValue(asRecord(item)?.type) === 'message');
  const messageRecord = asRecord(firstMessage);
  const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
  const text = content
    .map((item) => asRecord(item))
    .find((item) => stringValue(item?.type) === 'output_text' && typeof item?.text === 'string')?.text;

  return {
    transport: 'websocket',
    status: stringValue(record.status) ?? 'completed',
    responseId: stringValue(record.id),
    outputCount: output.length,
    outputTypes,
    ...(text ? { text } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
  };
};

const getTrafficEventPrefix = (sessionContextService?: ISessionContextService): 'provider' | 'evaluator' => {
  const trafficContext = sessionContextService?.getContext() ?? null;
  return trafficContext?.evaluator === true ? 'evaluator' : 'provider';
};

// Codex's `/backend-api/codex/responses` endpoint can ship terminal response
// frames with either an empty `output` array or no `output` field at all, even
// when the assistant message was already delivered via
// `response.output_item.done`. The agents-SDK runner trusts terminal
// `response.output` as the final output; when it is empty or missing it either
// sees no items and re-runs the same request until maxTurns or crashes while
// converting the terminal payload.
//
// This wrapper subclasses `OpenAIResponsesModel`, overrides the streaming
// fetch path, and patches the terminal frame in flight: it accumulates raw
// items from `response.output_item.done` and, only when terminal
// `response.output` is empty or missing, swaps in the accumulated items so the
// parent's existing conversion logic (`convertToOutputItem`) produces a normal
// `response_done` event.
export class CodexResponsesWSModel extends OpenAIResponsesWSModel {
  constructor(
    client: any,
    model: string,
    private readonly tokenManager: any,
    private readonly diagnosticLogger?: DiagnosticLogger,
    private readonly trafficLogger?: TrafficLogger,
    private readonly sessionContextService?: ISessionContextService,
  ) {
    super(client, model);
  }

  #buildTrafficMeta(requestId: string, requestData: Record<string, unknown>): Record<string, unknown> {
    const trafficContext = this.sessionContextService?.getContext() ?? null;
    const model = typeof requestData.model === 'string' ? requestData.model : this.#modelNameFallback();

    return {
      requestId,
      traceId: trafficContext?.traceId ?? this.trafficLogger?.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider: 'codex',
      model,
      modelClass: WS_RESPONSE_MODEL_CLASS,
      modelWrapperClass: WS_RESPONSE_WRAPPER_CLASS,
    };
  }

  #modelNameFallback(): string {
    return (this as any).model ?? 'unknown';
  }

  #logTrafficStarted(requestId: string, requestData: Record<string, unknown>, headers?: HeadersInit): void {
    if (!this.trafficLogger) return;
    const eventPrefix = getTrafficEventPrefix(this.sessionContextService);

    this.trafficLogger.debug('Codex websocket request start', {
      eventType: `${eventPrefix}.request.started`,
      category: 'provider',
      phase: 'request_start',
      direction: 'sent',
      ...this.#buildTrafficMeta(requestId, requestData),
      payload: requestData,
      ...(headers ? { headers: sanitizeHeaders(headers) } : {}),
    });
  }

  #logTrafficReceived(requestId: string, requestData: Record<string, unknown>, response: unknown): void {
    if (!this.trafficLogger) return;
    const eventPrefix = getTrafficEventPrefix(this.sessionContextService);

    this.trafficLogger.debug('Codex websocket response received', {
      eventType: `${eventPrefix}.response.received`,
      category: 'provider',
      phase: 'provider_response',
      direction: 'received',
      ...this.#buildTrafficMeta(requestId, requestData),
      payload: summarizeWebsocketResponse(response),
    });
  }

  #logTrafficFailed(requestId: string, requestData: Record<string, unknown>, error: unknown): void {
    if (!this.trafficLogger) return;

    this.trafficLogger.error('Codex websocket request failed', {
      eventType: 'provider.response.failed',
      category: 'provider',
      phase: 'provider_response',
      ...this.#buildTrafficMeta(requestId, requestData),
      error: describeError(error),
    });
  }

  async #withTrafficLogging(
    responseStream: AsyncIterable<any>,
    requestId: string,
    requestData: Record<string, unknown>,
  ): Promise<AsyncIterable<any>> {
    const self = this;

    async function* wrapped(): AsyncIterable<any> {
      try {
        for await (const event of responseStream) {
          if (
            event &&
            typeof event === 'object' &&
            ((event as any).type === 'response.completed' || (event as any).type === 'response.incomplete') &&
            (event as any).response
          ) {
            const response = (event as any).response;
            self.#logTrafficReceived(requestId, requestData, response);
          }
          yield event;
        }
      } catch (error) {
        self.#logTrafficFailed(requestId, requestData, error);
        throw error;
      }
    }

    return wrapped();
  }

  override async getResponse(request: any): Promise<any> {
    const currentTrace = getCurrentTrace();
    if (currentTrace) {
      return super.getResponse(request);
    }
    return withTrace('codex-responses-ws-model-trace', () => super.getResponse(request));
  }

  override _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = super._buildResponsesCreateRequest(request, stream);

    return {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request),
    };
  }

  protected override async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const requestId = randomUUID();
    const builtRequest = (this as any)._buildResponsesCreateRequest(request, true);
    const requestData = (asRecord(builtRequest?.requestData) ?? {}) as Record<string, unknown>;

    const accessToken = await this.tokenManager.getOrRefreshAccessToken();
    const accountId = this.tokenManager.getAccountId();

    const extraHeaders: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
    };
    if (accountId) {
      extraHeaders['chatgpt-account-id'] = accountId;
    }

    this.#logTrafficStarted(requestId, requestData, extraHeaders);

    const updatedRequest = {
      ...request,
      modelSettings: {
        ...request.modelSettings,
        providerData: {
          ...request.modelSettings?.providerData,
          extraHeaders: {
            ...request.modelSettings?.providerData?.extraHeaders,
            ...extraHeaders,
          },
        },
      },
    };

    if (!stream) {
      try {
        const response = await fetchAndReconstructUnaryResponse(
          () => super._fetchResponse(updatedRequest, true as false) as unknown as Promise<AsyncIterable<any>>,
          this.diagnosticLogger,
        );
        this.#logTrafficReceived(requestId, requestData, response);
        return response;
      } catch (error) {
        this.#logTrafficFailed(requestId, requestData, error);
        throw error;
      }
    }

    try {
      const response = (await super._fetchResponse(updatedRequest, stream as false)) as unknown as AsyncIterable<any>;
      return this.#withTrafficLogging(response, requestId, requestData);
    } catch (error) {
      this.#logTrafficFailed(requestId, requestData, error);
      throw error;
    }
  }
}

export class CodexResponsesModel extends OpenAIResponsesModel {
  constructor(client: any, model: string, private readonly diagnosticLogger?: DiagnosticLogger) {
    super(client, model);
  }

  _buildResponsesCreateRequest(request: any, stream: boolean): any {
    const built = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest.call(this, request, stream);

    return {
      ...built,
      requestData: normalizeCodexRequestData(built.requestData, request),
    };
  }

  async _fetchResponse(request: any, stream: boolean): Promise<any> {
    if (!stream) {
      return fetchAndReconstructUnaryResponse(
        () => (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, true),
        this.diagnosticLogger,
      );
    }

    const response = await (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, stream);
    return wrapCodexStream(response, this.diagnosticLogger);
  }
}

async function fetchAndReconstructUnaryResponse(
  fetchStream: () => Promise<AsyncIterable<any>>,
  logger?: DiagnosticLogger,
): Promise<any> {
  const eventStream = wrapCodexStream(await fetchStream(), logger);
  let finalResponse: any = null;
  for await (const event of eventStream) {
    if (TERMINAL_RESPONSE_EVENT_TYPES.has(event?.type) && event.response) {
      finalResponse = event.response;
    }
  }
  if (!finalResponse) {
    throw new Error('Codex connection closed before a terminal response event.');
  }
  return finalResponse;
}

export async function* wrapCodexStream(source: AsyncIterable<any>, logger?: DiagnosticLogger): AsyncIterable<any> {
  let accumulatedItems: any[] = [];
  for await (let event of source) {
    const type = event?.type;
    if (type === 'response.error' && event.error) {
      const errMsg = event.error.message || JSON.stringify(event.error);
      logger?.error?.('Codex stream received response.error event', {
        eventType: 'codex.response.stream_error_event',
        error: event.error,
      });
      throw new Error(`Codex provider stream error: ${errMsg}`);
    }

    if (type === 'response.output_item.done' && event.item) {
      accumulatedItems.push(event.item);
    } else if (TERMINAL_RESPONSE_EVENT_TYPES.has(type) && event.response) {
      const output = event.response.output;
      const isMissingOrEmptyOutput = output === undefined || (Array.isArray(output) && output.length === 0);
      if (isMissingOrEmptyOutput && accumulatedItems.length > 0) {
        const reconstructedOutput = accumulatedItems;
        accumulatedItems = [];
        if (reconstructedOutput.length >= SUSPICIOUS_RECONSTRUCTED_OUTPUT_ITEM_COUNT) {
          logger?.warn?.('Codex stream reconstructed a suspiciously large completed response output', {
            eventType: 'codex.reconstructed_output.suspicious',
            category: 'provider',
            phase: 'provider_response',
            responseId: stringValue(event.response.id),
            ...summarizeReconstructedItems(reconstructedOutput),
          });
        }
        try {
          event.response.output = reconstructedOutput;
        } catch {
          // Response object may be frozen; clone with the reconstructed output.
          event = { ...event, response: { ...event.response, output: reconstructedOutput } };
        }
      } else {
        accumulatedItems = [];
      }

      // Check if output is still missing/empty and there's a failed status or error details
      const finalOutput = event.response.output;
      const isStillMissingOutput =
        finalOutput === undefined || (Array.isArray(finalOutput) && finalOutput.length === 0);
      if (isStillMissingOutput) {
        if (event.response.error) {
          const errMsg = event.response.error.message || JSON.stringify(event.response.error);
          logger?.error?.(`Codex response terminal event "${type}" has error details`, {
            eventType: 'codex.response.terminal_error',
            responseId: event.response.id,
            status: event.response.status,
            error: event.response.error,
          });
          throw new Error(`Codex provider error: ${errMsg}`);
        } else if (event.response.status === 'failed') {
          logger?.error?.(`Codex response terminal event "${type}" has failed status without error details`, {
            eventType: 'codex.response.terminal_failed',
            responseId: event.response.id,
            status: event.response.status,
          });
          throw new Error(`Codex provider response failed without explicit error details.`);
        }
      }
    }
    yield event;
  }
}
