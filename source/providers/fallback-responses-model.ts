import { randomUUID } from 'node:crypto';
import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { describeError } from '../utils/error-helpers.js';
import { summarizeReceivedTraffic } from '../services/provider-traffic.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import { sanitizeHeaders } from '../utils/header-sanitizer.js';
import { isRetryableTransportError } from '../services/retry-error-classification.js';
import { computeUpstreamRetryDelayMs } from '../services/upstream-retry-policy.js';

export { isNetworkProtocolError } from '../services/retry-error-classification.js';

export interface FallbackState {
  isDowngraded: boolean;
  /** Called the first time the WS transport degrades to HTTP. */
  onDowngrade?: () => void;
  /** Called before each retry backoff while WS transport is still retrying. */
  onRetry?: () => void;
  /** Forces the transport into downgraded HTTP mode after session-level retry exhaustion. */
  forceDowngrade?: (error: unknown) => void;
}

/**
 * Thrown when a provider that requires WS for conversation chaining
 * (e.g. Codex) falls back to HTTP mid-request, because the HTTP
 * endpoint cannot reconstruct server-managed history. The session
 * layer should catch this and retry with full conversation history.
 */
export class ChainingTransportDowngradeError extends Error {
  override readonly name = 'ChainingTransportDowngradeError' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export const DEFAULT_STREAM_MAX_RETRIES = 5;

const CODEX_SERVER_HISTORY_TOOL_RESULT_TYPES = new Set([
  'function_call_output',
  'function_call_result',
  'function_call_output_result',
  'tool_call_output',
  'tool_call_result',
  'tool_call_output_item',
  'local_shell_call_output',
  'shell_call_output',
  'computer_call_output',
  'computer_call_result',
  'apply_patch_call_output',
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const isUserInputMessage = (item: unknown): boolean => asRecord(item)?.role === 'user';

const isToolResultItem = (item: unknown): boolean => {
  const type = asRecord(item)?.type;
  return typeof type === 'string' && CODEX_SERVER_HISTORY_TOOL_RESULT_TYPES.has(type);
};

const findServerManagedDeltaStart = (input: unknown[]): number => {
  let trailingToolResultStart = input.length;
  while (trailingToolResultStart > 0 && isToolResultItem(input[trailingToolResultStart - 1])) {
    trailingToolResultStart--;
  }
  if (trailingToolResultStart < input.length) {
    return trailingToolResultStart;
  }

  for (let index = input.length - 1; index >= 0; index--) {
    if (isUserInputMessage(input[index])) {
      return index;
    }
  }

  return 0;
};

const filterServerManagedInput = (input: unknown): unknown => {
  if (!Array.isArray(input) || input.length <= 1) {
    return input;
  }

  const deltaStart = findServerManagedDeltaStart(input);
  return deltaStart > 0 ? input.slice(deltaStart) : input;
};

const getResponseIdFromResponse = (response: unknown): string | undefined => {
  const record = asRecord(response);
  const responseId = record?.responseId ?? record?.id;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
};

const getResponseIdFromStreamEvent = (event: unknown): string | undefined => {
  const record = asRecord(event);
  if (record?.type !== 'response_done') {
    return undefined;
  }

  return getResponseIdFromResponse(record.response) ?? getResponseIdFromResponse(record);
};

const hasGenerateFalse = (request: ModelRequest): boolean =>
  (request.modelSettings?.providerData as Record<string, unknown> | undefined)?.generate === false;

const withProviderData = (request: ModelRequest, providerData: Record<string, unknown>): ModelRequest => ({
  ...request,
  modelSettings: {
    ...request.modelSettings,
    providerData: {
      ...request.modelSettings?.providerData,
      ...providerData,
    },
  },
});

type PreparedCodexRequest = {
  request: ModelRequest;
  warmupRequest?: ModelRequest;
};

type WarmupKind = 'unary' | 'stream';

type WarmupRetryDependencies = {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
};

// The SDK's convertToOutputItem crashes with TypeError when the WS model returns
// a failed API response that has no `output` field. Treat it as a WS-path failure
// so we can fall back to the HTTP model.
function isWsResponseOutputMissing(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    typeof (err as TypeError).message === 'string' &&
    (err as TypeError).message.includes("'map'")
  );
}

export class FallbackResponsesModel implements Model {
  private readonly codexPreviousResponseIds = new Map<string, string>();
  private readonly warmupSleep: (delayMs: number) => Promise<void>;
  private readonly warmupRandom: () => number;

  constructor(
    private readonly wsModel: Model,
    private readonly httpModel: Model,
    private readonly state: FallbackState,
    private readonly onDowngrade?: (error: unknown) => void,
    private readonly loggingService?: any,
    private readonly providerId?: string,
    private readonly sessionContextService?: ISessionContextService,
    warmupRetryDependencies?: WarmupRetryDependencies,
  ) {
    this.state.forceDowngrade = (error: unknown) => this.#notifyDowngrade(error);
    this.warmupSleep =
      warmupRetryDependencies?.sleep ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.warmupRandom = warmupRetryDependencies?.random ?? Math.random;
  }

  #getCodexServerHistoryKey(): string | null {
    if (this.providerId !== 'codex') {
      return null;
    }

    const trafficContext = this.sessionContextService?.getContext() ?? null;
    return trafficContext?.sessionId ?? trafficContext?.traceId ?? null;
  }

  #prepareCodexServerHistoryRequest(request: ModelRequest): ModelRequest {
    // When downgraded to HTTP, server-managed history is not supported.
    // Strip previousResponseId and return the input as-is so the caller
    // (which may have already delta-filtered) gets the raw request through.
    if (this.state.isDowngraded) {
      const { previousResponseId: _prid, ...rest } = request as any;
      return rest as ModelRequest;
    }

    const explicitPreviousResponseId =
      typeof request.previousResponseId === 'string' && request.previousResponseId.length > 0
        ? request.previousResponseId
        : undefined;
    const input = (request as any).input;
    const previousResponseId = explicitPreviousResponseId ?? this.#getRememberedCodexResponseIdForRequest(request);

    if (!previousResponseId) {
      return request;
    }

    const filteredInput = filterServerManagedInput(input);
    if (request.previousResponseId === previousResponseId && filteredInput === input) {
      return request;
    }

    return {
      ...request,
      previousResponseId,
      input: filteredInput as any,
    };
  }

  #getRememberedCodexResponseIdForRequest(request: ModelRequest): string | undefined {
    const key = this.#getCodexServerHistoryKey();
    if (!key || hasGenerateFalse(request)) {
      return undefined;
    }

    const input = (request as any).input;
    const isInternalToolContinuation =
      Array.isArray(input) &&
      input.length > 1 &&
      input.some(isUserInputMessage) &&
      isToolResultItem(input[input.length - 1]);
    return isInternalToolContinuation ? this.codexPreviousResponseIds.get(key) : undefined;
  }

  #prepareCodexServerHistoryRequests(request: ModelRequest): PreparedCodexRequest {
    const key = this.#getCodexServerHistoryKey();
    if (!key || hasGenerateFalse(request)) {
      return { request };
    }

    const preparedRequest = this.#prepareCodexServerHistoryRequest(request);
    if (preparedRequest.previousResponseId) {
      return { request: preparedRequest };
    }

    const input = (request as any).input;
    if (!Array.isArray(input) || input.length === 0) {
      return { request };
    }

    const deltaStart = findServerManagedDeltaStart(input);
    const warmupInput = deltaStart > 0 ? input.slice(0, deltaStart) : [];
    const deltaInput = deltaStart > 0 ? input.slice(deltaStart) : input;
    return {
      warmupRequest: withProviderData(
        {
          ...request,
          input: warmupInput as any,
        },
        { generate: false },
      ),
      request: {
        ...request,
        input: deltaInput as any,
      },
    };
  }

  #withCodexPreviousResponseId(request: ModelRequest, previousResponseId: string | undefined): ModelRequest {
    if (!previousResponseId) {
      return request;
    }

    return this.#prepareCodexServerHistoryRequest({
      ...request,
      previousResponseId,
    });
  }

  #rememberCodexResponseId(responseId: string | undefined): void {
    if (!responseId) {
      return;
    }

    const key = this.#getCodexServerHistoryKey();
    if (key) {
      this.codexPreviousResponseIds.set(key, responseId);
    }
  }

  /** Flip downgrade state, clear stale WS response IDs, and notify listeners. */
  #notifyDowngrade(error: unknown): void {
    if (this.state.isDowngraded) {
      return;
    }
    this.state.isDowngraded = true;
    // WS-established response IDs are meaningless to the HTTP endpoint.
    this.codexPreviousResponseIds.clear();
    if (this.onDowngrade) {
      this.onDowngrade(error);
    }
    if (this.state.onDowngrade) {
      this.state.onDowngrade();
    }
  }

  async #shouldRetryCodexWarmup(
    request: ModelRequest,
    error: unknown,
    kind: WarmupKind,
    attempt: number,
  ): Promise<boolean> {
    const retryAdvice =
      typeof this.wsModel.getRetryAdvice === 'function'
        ? await this.wsModel.getRetryAdvice({ request, error, stream: kind === 'stream', attempt })
        : undefined;

    return retryAdvice?.suggested === true && retryAdvice?.replaySafety === 'safe';
  }

  async #sleepBeforeCodexWarmupRetry(attempt: number): Promise<void> {
    const delayMs = computeUpstreamRetryDelayMs({ attemptNumber: attempt, random: this.warmupRandom });
    await this.warmupSleep(delayMs);
  }

  async #warmupCodexUnary(request: ModelRequest | undefined): Promise<string | undefined> {
    if (!request) {
      return undefined;
    }

    const maxAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        const response = await this.wsModel.getResponse(request);
        const responseId = getResponseIdFromResponse(response);
        this.#rememberCodexResponseId(responseId);
        return responseId;
      } catch (error) {
        const canSafelyRetry = await this.#shouldRetryCodexWarmup(request, error, 'unary', attempt);
        if (!canSafelyRetry) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          return undefined;
        }
        await this.#sleepBeforeCodexWarmupRetry(attempt);
        attempt++;
      }
    }

    return undefined;
  }

  async #warmupCodexStream(request: ModelRequest | undefined): Promise<string | undefined> {
    if (!request) {
      return undefined;
    }

    const maxAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        let responseId: string | undefined;
        for await (const event of this.wsModel.getStreamedResponse(request)) {
          responseId = getResponseIdFromStreamEvent(event) ?? responseId;
        }
        this.#rememberCodexResponseId(responseId);
        return responseId;
      } catch (error) {
        const canSafelyRetry = await this.#shouldRetryCodexWarmup(request, error, 'stream', attempt);
        if (!canSafelyRetry) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          return undefined;
        }
        await this.#sleepBeforeCodexWarmupRetry(attempt);
        attempt++;
      }
    }

    return undefined;
  }

  #getEffectiveCodexRequestAfterWarmup(
    originalRequest: ModelRequest,
    preparedRequest: PreparedCodexRequest,
    warmupResponseId: string | undefined,
  ): ModelRequest {
    if (!preparedRequest.warmupRequest) {
      return preparedRequest.request;
    }

    return warmupResponseId
      ? this.#withCodexPreviousResponseId(preparedRequest.request, warmupResponseId)
      : originalRequest;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    if (this.state.isDowngraded) {
      const effectiveRequest = this.#prepareCodexServerHistoryRequest(request);
      const response = await this.httpModel.getResponse(effectiveRequest);
      this.#rememberCodexResponseId(getResponseIdFromResponse(response));
      return response;
    }

    const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
    const warmupResponseId = await this.#warmupCodexUnary(preparedRequest.warmupRequest);
    const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const trafficContext = this.sessionContextService?.getContext() ?? null;
    const modelClass = (this.wsModel as any)?.constructor?.name || 'UnknownModel';
    const baseMeta = {
      requestId,
      traceId: trafficContext?.traceId ?? this.loggingService?.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider: this.providerId || 'unknown',
      model,
      modelClass,
      modelWrapperClass: this.constructor.name,
    };

    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    // Log request start
    if (this.loggingService && this.providerId) {
      let sentBody: any = request;
      let sanitizedHeaders: Record<string, string> | undefined;
      try {
        if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
          const built = (this.wsModel as any)._buildResponsesCreateRequest(effectiveRequest, false);
          sentBody = built.requestData;
          if (built.sdkRequestHeaders) {
            sanitizedHeaders = sanitizeHeaders(built.sdkRequestHeaders);
          }
        }
      } catch {
        // fallback
      }

      this.loggingService.debug(`${this.providerId} ws request start`, {
        eventType: `${eventPrefix}.request.started`,
        category: 'provider',
        phase: 'request_start',
        direction: 'sent',
        ...baseMeta,
        messageCount: Array.isArray(sentBody?.messages) ? sentBody.messages.length : undefined,
        messages: sentBody?.messages,
        toolsCount: Array.isArray(sentBody?.tools) ? sentBody.tools.length : undefined,
        payload: sentBody,
        headers: sanitizedHeaders,
      });
    }

    // Retry WS transport errors before falling back to HTTP.
    const maxWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let lastTransportError: unknown;
    for (let wsAttempt = 1; wsAttempt <= maxWsAttempts; wsAttempt++) {
      try {
        const response = await this.wsModel.getResponse(effectiveRequest);
        this.#rememberCodexResponseId(getResponseIdFromResponse(response));

        // Log response complete
        if (this.loggingService && this.providerId) {
          const summary = {
            transport: 'json' as const,
            status: 200,
            errorFrames: [],
            malformedFrames: [],
            unknownFrames: [],
            payload: response.providerData || response,
          };

          this.loggingService.debug(`${this.providerId} ws response received`, {
            eventType: `${eventPrefix}.response.received`,
            category: 'provider',
            phase: 'provider_response',
            direction: 'received',
            ...baseMeta,
            status: 200,
            text: response.output?.[0]?.type === 'message' ? (response.output[0] as any).content?.[0]?.text : undefined,
            payload: summary,
          });
        }

        return response;
      } catch (error) {
        // SDK TypeError crash (missing output) is deterministic — retrying WS
        // won't help. Fall back to HTTP immediately.
        if (isWsResponseOutputMissing(error)) {
          this.#notifyDowngrade(error);
          if (this.providerId === 'codex' && effectiveRequest.previousResponseId) {
            throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
              cause: error,
            });
          }
          const response = await this.httpModel.getResponse(effectiveRequest);
          this.#rememberCodexResponseId(getResponseIdFromResponse(response));
          return response;
        }

        // Non-transport errors are not retried.
        if (!isRetryableTransportError(error, this.loggingService).transportFallback) {
          throw error;
        }

        if (this.loggingService && this.providerId) {
          this.loggingService.error(`${this.providerId} ws request failed`, {
            eventType: 'provider.response.failed',
            category: 'provider',
            phase: 'provider_response',
            ...baseMeta,
            error: describeError(error),
            wsAttempt,
            wsMaxAttempts: maxWsAttempts,
          });
        }

        lastTransportError = error;
        if (wsAttempt < maxWsAttempts) {
          this.state.onRetry?.();
          const delayMs = computeUpstreamRetryDelayMs({
            attemptNumber: wsAttempt,
            random: this.warmupRandom,
          });
          await this.warmupSleep(delayMs);
          continue;
        }
      }
    }

    // All WS retries exhausted — fall back to HTTP.
    this.#notifyDowngrade(lastTransportError!);
    if (this.providerId === 'codex' && effectiveRequest.previousResponseId) {
      throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
        cause: lastTransportError,
      });
    }
    const response = await this.httpModel.getResponse(effectiveRequest);
    this.#rememberCodexResponseId(getResponseIdFromResponse(response));
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.state.isDowngraded) {
      const effectiveRequest = this.#prepareCodexServerHistoryRequest(request);
      for await (const event of this.httpModel.getStreamedResponse(effectiveRequest)) {
        this.#rememberCodexResponseId(getResponseIdFromStreamEvent(event));
        yield event;
      }
      return;
    }

    const preparedRequest = this.#prepareCodexServerHistoryRequests(request);
    const warmupResponseId = await this.#warmupCodexStream(preparedRequest.warmupRequest);
    const effectiveRequest = this.#getEffectiveCodexRequestAfterWarmup(request, preparedRequest, warmupResponseId);

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const trafficContext = this.sessionContextService?.getContext() ?? null;
    const modelClass = (this.wsModel as any)?.constructor?.name || 'UnknownModel';
    const baseMeta = {
      requestId,
      traceId: trafficContext?.traceId ?? this.loggingService?.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider: this.providerId || 'unknown',
      model,
      modelClass,
      modelWrapperClass: this.constructor.name,
    };

    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    // Log request start
    if (this.loggingService && this.providerId) {
      let sentBody: any = request;
      let sanitizedHeaders: Record<string, string> | undefined;
      try {
        if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
          const built = (this.wsModel as any)._buildResponsesCreateRequest(effectiveRequest, true);
          sentBody = built.requestData;
          if (built.sdkRequestHeaders) {
            sanitizedHeaders = sanitizeHeaders(built.sdkRequestHeaders);
          }
        }
      } catch {
        // fallback
      }

      this.loggingService.debug(`${this.providerId} ws stream request start`, {
        eventType: `${eventPrefix}.request.started`,
        category: 'provider',
        phase: 'request_start',
        direction: 'sent',
        ...baseMeta,
        messageCount: Array.isArray(sentBody?.messages) ? sentBody.messages.length : undefined,
        messages: sentBody?.messages,
        toolsCount: Array.isArray(sentBody?.tools) ? sentBody.tools.length : undefined,
        payload: sentBody,
        headers: sanitizedHeaders,
      });
    }

    // Retry WS transport errors before falling back to HTTP.
    // We can only retry while no events have been yielded — once the
    // consumer has seen partial output we're committed.
    const maxWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let lastTransportError: unknown;
    for (let wsAttempt = 1; wsAttempt <= maxWsAttempts; wsAttempt++) {
      let started = false;
      const sseEvents: any[] = [];
      try {
        const stream = this.wsModel.getStreamedResponse(effectiveRequest);
        for await (const event of stream) {
          if (event.type === 'model' && event.event) {
            sseEvents.push(event.event);
          }
          this.#rememberCodexResponseId(getResponseIdFromStreamEvent(event));
          started = true;
          yield event;
        }

        // Log response complete
        if (this.loggingService && this.providerId && sseEvents.length > 0) {
          const sseText = sseEvents.map((ev) => `data: ${JSON.stringify(ev)}`).join('\n\n');

          const fakeResponse = new Response(sseText, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });

          const summary = await summarizeReceivedTraffic(fakeResponse);
          const summaryPayload = summary.payload as any;
          const responseText = summaryPayload?.choices?.[0]?.delta?.content;
          const toolCalls = summaryPayload?.choices?.[0]?.delta?.tool_calls;

          this.loggingService.debug(`${this.providerId} ws stream response received`, {
            eventType: `${eventPrefix}.response.received`,
            category: 'provider',
            phase: 'provider_response',
            direction: 'received',
            ...baseMeta,
            status: 200,
            text: responseText,
            toolCalls,
            payload: summary,
          });
        }
        return;
      } catch (error) {
        if (!isRetryableTransportError(error, this.loggingService).transportFallback) {
          throw error;
        }

        if (this.loggingService && this.providerId) {
          this.loggingService.error(`${this.providerId} ws stream request failed`, {
            eventType: 'provider.response.failed',
            category: 'provider',
            phase: 'provider_response',
            ...baseMeta,
            error: describeError(error),
            wsAttempt,
            wsMaxAttempts: maxWsAttempts,
          });
        }

        // Mid-stream failures are retried by the session layer from repaired
        // history. Do not downgrade to HTTP or retry — the consumer has
        // already seen partial output.
        if (started) {
          throw error;
        }

        lastTransportError = error;
        if (wsAttempt < maxWsAttempts) {
          this.state.onRetry?.();
          const delayMs = computeUpstreamRetryDelayMs({
            attemptNumber: wsAttempt,
            random: this.warmupRandom,
          });
          await this.warmupSleep(delayMs);
          continue;
        }
      }
    }

    // All WS retries exhausted — fall back to HTTP.
    this.#notifyDowngrade(lastTransportError!);
    if (this.providerId === 'codex' && effectiveRequest.previousResponseId) {
      throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
        cause: lastTransportError,
      });
    }
    for await (const event of this.httpModel.getStreamedResponse(effectiveRequest)) {
      this.#rememberCodexResponseId(getResponseIdFromStreamEvent(event));
      yield event;
    }
  }

  getRetryAdvice(args: any): any {
    const activeModel = this.state.isDowngraded ? this.httpModel : this.wsModel;
    if (typeof activeModel.getRetryAdvice === 'function') {
      return activeModel.getRetryAdvice(args);
    }
    return undefined;
  }

  get _client(): any {
    return (this.wsModel as any)._client ?? (this.httpModel as any)._client;
  }

  async close(): Promise<void> {
    if (typeof (this.wsModel as any).close === 'function') {
      await (this.wsModel as any).close();
    }
    if (typeof (this.httpModel as any).close === 'function') {
      await (this.httpModel as any).close();
    }
  }
}
