import { randomUUID } from 'node:crypto';
import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import type { ISessionContextService, IProviderTraffic } from '../services/service-interfaces.js';

const DUMMY_PROVIDER_TRAFFIC: IProviderTraffic = {
  recordRequestStart() {},
  async recordResponseReceived() {},
  recordRequestFailed() {},
};
import { sanitizeHeaders } from '../utils/header-sanitizer.js';
import { isRetryableTransportError } from '../services/retry/retry-error-classification.js';
import { computeUpstreamRetryDelayMs } from '../services/retry/upstream-retry-policy.js';

export { isNetworkProtocolError } from '../services/retry/retry-error-classification.js';

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

type RetryDependencies = {
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
  private readonly warmupSleep: (delayMs: number) => Promise<void>;
  private readonly warmupRandom: () => number;
  private readonly providerTraffic: IProviderTraffic;

  constructor(
    private readonly wsModel: Model,
    private readonly httpModel: Model,
    private readonly state: FallbackState,
    private readonly onDowngrade?: (error: unknown) => void,
    private readonly loggingService?: any,
    private readonly providerId?: string,
    _sessionContextService?: ISessionContextService,
    warmupRetryDependencies?: RetryDependencies,
  ) {
    this.state.forceDowngrade = (error: unknown) => this.#notifyDowngrade(error);
    this.warmupSleep =
      warmupRetryDependencies?.sleep ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.warmupRandom = warmupRetryDependencies?.random ?? Math.random;
    this.providerTraffic = loggingService?.providerTraffic ?? DUMMY_PROVIDER_TRAFFIC;
  }

  /** Flip downgrade state and notify listeners. */
  #notifyDowngrade(error: unknown): void {
    if (this.state.isDowngraded) {
      return;
    }
    this.state.isDowngraded = true;
    if (this.onDowngrade) {
      this.onDowngrade(error);
    }
    if (this.state.onDowngrade) {
      this.state.onDowngrade();
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    if (this.state.isDowngraded) {
      return this.httpModel.getResponse(request);
    }

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const modelClass = (this.wsModel as any)?.constructor?.name || 'UnknownModel';

    // Log request start
    let sentBody: any = request;
    let sanitizedHeaders: Record<string, string> | undefined;
    try {
      if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
        const built = (this.wsModel as any)._buildResponsesCreateRequest(request, false);
        sentBody = built.requestData;
        if (built.sdkRequestHeaders) {
          sanitizedHeaders = sanitizeHeaders(built.sdkRequestHeaders);
        }
      }
    } catch {
      // fallback
    }

    this.providerTraffic.recordRequestStart({
      requestId,
      provider: this.providerId || 'unknown',
      model,
      sentBody,
      headers: sanitizedHeaders,
      modelClass,
      modelWrapperClass: this.constructor.name,
    });

    // Retry WS transport errors before falling back to HTTP.
    const maxWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let lastTransportError: unknown;
    for (let wsAttempt = 1; wsAttempt <= maxWsAttempts; wsAttempt++) {
      try {
        const response = await this.wsModel.getResponse(request);

        // Log response complete
        await this.providerTraffic.recordResponseReceived({
          requestId,
          provider: this.providerId || 'unknown',
          model,
          status: 200,
          response,
          transport: 'websocket',
          modelClass,
          modelWrapperClass: this.constructor.name,
        });

        return response;
      } catch (error) {
        // SDK TypeError crash (missing output) is deterministic — retrying WS
        // won't help. Fall back to HTTP immediately.
        if (isWsResponseOutputMissing(error)) {
          this.#notifyDowngrade(error);
          if (this.providerId === 'codex' && request.previousResponseId) {
            throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
              cause: error,
            });
          }
          return this.httpModel.getResponse(request);
        }

        // Non-transport errors are not retried.
        if (!isRetryableTransportError(error, this.loggingService).transportFallback) {
          throw error;
        }

        this.providerTraffic.recordRequestFailed({
          requestId,
          provider: this.providerId || 'unknown',
          model,
          error,
          modelClass,
          modelWrapperClass: this.constructor.name,
          wsAttempt,
          wsMaxAttempts: maxWsAttempts,
        });

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
    if (this.providerId === 'codex' && request.previousResponseId) {
      throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
        cause: lastTransportError,
      });
    }
    return this.httpModel.getResponse(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.state.isDowngraded) {
      yield* this.httpModel.getStreamedResponse(request);
      return;
    }

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const modelClass = (this.wsModel as any)?.constructor?.name || 'UnknownModel';

    // Log request start
    let sentBody: any = request;
    let sanitizedHeaders: Record<string, string> | undefined;
    try {
      if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
        const built = (this.wsModel as any)._buildResponsesCreateRequest(request, true);
        sentBody = built.requestData;
        if (built.sdkRequestHeaders) {
          sanitizedHeaders = sanitizeHeaders(built.sdkRequestHeaders);
        }
      }
    } catch {
      // fallback
    }

    this.providerTraffic.recordRequestStart({
      requestId,
      provider: this.providerId || 'unknown',
      model,
      sentBody,
      headers: sanitizedHeaders,
      modelClass,
      modelWrapperClass: this.constructor.name,
    });

    // Retry WS transport errors before falling back to HTTP.
    // We can only retry while no events have been yielded — once the
    // consumer has seen partial output we're committed.
    const maxWsAttempts = DEFAULT_STREAM_MAX_RETRIES + 1;
    let lastTransportError: unknown;
    for (let wsAttempt = 1; wsAttempt <= maxWsAttempts; wsAttempt++) {
      let started = false;
      const sseEvents: any[] = [];
      try {
        const stream = this.wsModel.getStreamedResponse(request);
        for await (const event of stream) {
          if (event.type === 'model' && event.event) {
            sseEvents.push(event.event);
          }
          started = true;
          yield event;
        }

        // Log response complete
        if (sseEvents.length > 0) {
          const terminalEvent = [...sseEvents]
            .reverse()
            .find(
              (ev) =>
                ev && typeof ev === 'object' && (ev.type === 'response.completed' || ev.type === 'response.incomplete'),
            );
          const responsePayload = terminalEvent?.response ?? sseEvents;

          await this.providerTraffic.recordResponseReceived({
            requestId,
            provider: this.providerId || 'unknown',
            model,
            status: 200,
            response: responsePayload,
            transport: 'websocket',
            modelClass,
            modelWrapperClass: this.constructor.name,
          });
        }
        return;
      } catch (error) {
        if (!isRetryableTransportError(error, this.loggingService).transportFallback) {
          throw error;
        }

        this.providerTraffic.recordRequestFailed({
          requestId,
          provider: this.providerId || 'unknown',
          model,
          error,
          modelClass,
          modelWrapperClass: this.constructor.name,
          wsAttempt,
          wsMaxAttempts: maxWsAttempts,
        });

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
    if (this.providerId === 'codex' && request.previousResponseId) {
      throw new ChainingTransportDowngradeError('Codex WS connection failed; cannot chain via HTTP', {
        cause: lastTransportError,
      });
    }
    yield* this.httpModel.getStreamedResponse(request);
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
