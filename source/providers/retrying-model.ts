import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { isNetworkProtocolError } from '../services/retry/retry-error-classification.js';
import {
  classifyUpstreamRetryableError,
  computeUpstreamRetryDelayMs,
} from '../services/retry/upstream-retry-policy.js';

type RetryingModelOptions = {
  retryAttempts: number;
  loggingService?: Pick<ILoggingService, 'warn' | 'info'>;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onRetry?: () => void;
};

/** Decorates one application-owned streamed turn with pre-event retries. */
export class RetryingModel implements StreamedModelTurn {
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #random: () => number;

  constructor(private readonly model: StreamedModelTurn, private readonly options: RetryingModelOptions) {
    this.#sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.#random = options.random ?? Math.random;
  }

  get wrappedModel(): StreamedModelTurn {
    return this.model;
  }

  /** Rebind the request-scoped retry observer when a cached provider is reused. */
  setRetryCallback(callback?: () => void): void {
    this.options.onRetry = callback;
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    for (let attempt = 0; ; attempt++) {
      let committed = false;
      try {
        for await (const event of this.model.stream(request)) {
          committed = true;
          yield event;
        }
        return;
      } catch (error) {
        if (committed || !this.#canRetry(error, attempt)) {
          this.#logExhaustion(error, attempt);
          throw error;
        }
        await this.#backoff(error, attempt + 1);
      }
    }
  }

  async close(): Promise<void> {
    await (this.model as { close?: () => Promise<void> }).close?.();
  }

  #canRetry(error: unknown, attempt: number): boolean {
    return attempt < this.options.retryAttempts && this.#isRetryable(error);
  }

  async #backoff(error: unknown, attemptNumber: number): Promise<void> {
    const delayMs = computeUpstreamRetryDelayMs({
      attemptIndex: attemptNumber - 1,
      random: this.#random,
    });
    this.options.loggingService?.warn('Retrying model request after upstream failure', {
      eventType: 'retry.model_transport',
      category: 'retry',
      attempt: attemptNumber,
      maxRetries: this.options.retryAttempts,
      delayMs,
      error: error instanceof Error ? error.message : String(error),
    });
    this.options.onRetry?.();
    await this.#sleep(delayMs);
  }

  #logExhaustion(error: unknown, attempt: number): void {
    if (!this.#isRetryable(error)) return;
    this.options.loggingService?.warn('Model transport retries exhausted', {
      eventType: 'retry.model_transport_exhausted',
      category: 'retry',
      attempts: attempt + 1,
      maxRetries: this.options.retryAttempts,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #isRetryable(error: unknown): boolean {
    return isNetworkProtocolError(error) || classifyUpstreamRetryableError(error).retryable;
  }
}
