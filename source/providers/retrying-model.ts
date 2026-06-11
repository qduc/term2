import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import type { ILoggingService } from '../services/service-interfaces.js';
import { isNetworkProtocolError } from '../services/retry-error-classification.js';
import { classifyUpstreamRetryableError, computeUpstreamRetryDelayMs } from '../services/upstream-retry-policy.js';

type RetryingModelOptions = {
  retryAttempts: number;
  loggingService?: Pick<ILoggingService, 'warn' | 'info'>;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onRetry?: () => void;
};

export class RetryingModel implements Model {
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #random: () => number;

  constructor(private readonly model: Model, private readonly options: RetryingModelOptions) {
    this.#sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.#random = options.random ?? Math.random;
  }

  get wrappedModel(): Model {
    return this.model;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.#retry(() => this.model.getResponse(request));
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let committed = false;
      try {
        for await (const event of this.model.getStreamedResponse(request)) {
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
    await (this.model as any).close?.();
  }

  async #retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!this.#canRetry(error, attempt)) {
          this.#logExhaustion(error, attempt);
          throw error;
        }
        await this.#backoff(error, attempt + 1);
      }
    }
  }

  #canRetry(error: unknown, attempt: number): boolean {
    return attempt < this.options.retryAttempts && this.#isRetryable(error);
  }

  async #backoff(error: unknown, attemptNumber: number): Promise<void> {
    const delayMs = computeUpstreamRetryDelayMs({
      attemptNumber,
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
    if (!this.#isRetryable(error)) {
      return;
    }
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
