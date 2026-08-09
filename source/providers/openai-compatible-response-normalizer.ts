import OpenAI from 'openai';
import type { ILoggingService } from '../services/service-interfaces.js';

function normalizeMessageField(_target: any): void {
  /* no-op: raw wire fields are preserved verbatim */
}

/** Mutable per-request capture for a provider-reported USD charge trailer. */
export interface CostTrailerCapture {
  /** USD charge string from the most recent request's cost-only trailer. */
  cost?: string;
}

function isCostOnlyTrailer(chunk: any): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const hasEmptyChoices = !chunk.choices || (Array.isArray(chunk.choices) && chunk.choices.length === 0);
  if (!hasEmptyChoices) return false;
  if (chunk.usage != null) return false;
  return typeof chunk.cost === 'string' || typeof chunk['x-opencode-type'] === 'string';
}

function createNormalizedReasoningStream(
  stream: AsyncIterable<any>,
  loggingService?: ILoggingService,
  costCapture?: CostTrailerCapture,
): AsyncIterable<any> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          let result = await iterator.next();
          while (!result.done && isCostOnlyTrailer(result.value)) {
            // Intercept the provider-reported USD charge as billing metadata
            // while keeping the trailer out of the SDK usage accumulator.
            if (typeof result.value?.cost === 'string' && costCapture) {
              costCapture.cost = result.value.cost;
            }
            if (loggingService) {
              loggingService.debug(
                '[COST_TRAILER] Captured provider cost-only trailer as billing metadata (kept out of SDK usage accumulator)',
              );
            }
            result = await iterator.next();
          }
          if (!result.done && result.value?.choices) {
            const choices = result.value.choices;
            const hasMultipleChoices = choices.length > 1;
            const hasNonZeroOrMissingIndex = choices.some(
              (choice: any) => choice.index === undefined || choice.index !== 0,
            );

            if (hasMultipleChoices || hasNonZeroOrMissingIndex) {
              const chunkStr = JSON.stringify(result.value, null, 2);
              const msg = `[DEBUG_MALFORMED_RESPONSE] Intercepted malformed response chunk: ${chunkStr}`;
              if (loggingService) {
                loggingService.warn(msg);
              }
            }

            if (choices.length === 1 && choices[0].index !== 0) {
              choices[0].index = 0;
            }

            for (const choice of choices) {
              normalizeMessageField(choice.delta);
            }
          }
          return result;
        },
      };
    },
  };
}

/**
 * Normalizes `reasoning_content` -> `reasoning` on responses from the OpenAI client.
 *
 * Cost-only trailers are no longer discarded outright: the reported USD charge
 * is captured into `costCapture` (billing metadata) while the trailer itself is
 * still kept out of the SDK usage accumulator.
 */
export function applyClientResponseNormalization(
  client: OpenAI,
  loggingService?: ILoggingService,
  costCapture?: CostTrailerCapture,
): void {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions) as (...args: any[]) => any;

  (client.chat.completions as any).create = async (...args: any[]) => {
    if (costCapture) delete costCapture.cost;
    const result = await originalCreate(...args);

    if (!result || typeof result !== 'object') return result;

    if (Array.isArray(result.choices)) {
      for (const choice of result.choices) {
        normalizeMessageField(choice.message);
      }
      return result;
    }

    if (typeof result[Symbol.asyncIterator] === 'function') {
      return createNormalizedReasoningStream(result, loggingService, costCapture);
    }

    return result;
  };
}
