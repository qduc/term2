import OpenAI from 'openai';
import type { ILoggingService } from '../../shared/service-interfaces.js';

/** Mutable per-request capture for a provider-reported USD charge trailer. */
export interface CostTrailerCapture {
  /** USD charge string from the most recent request's cost-only trailer. */
  cost?: string;
}

function asUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function usageCostValue(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

/**
 * The charge a usage object reports, in provider units (USD for OpenRouter).
 *
 * OpenRouter reports `cost` as what it charged the account's credits and
 * `cost_details.upstream_inference_cost` as what the upstream provider
 * charged. Without bring-your-own-key they describe the same request
 * (`upstream_inference_cost` is OpenRouter's upstream bill, close to `cost`;
 * see the `is_byok: false` frames in fixtures/openrouter), so adding them
 * would double count. With `is_byok: true` OpenRouter bills only its BYOK fee
 * (often `cost: 0`) and the upstream charge goes to the user's own key, so the
 * request's real cost is the sum. Reading `cost` alone recorded those requests
 * as an exact $0, which hid them from run summaries and the run budget.
 *
 * Returns undefined when no cost field is present. A missing `cost` falls back
 * to the upstream charge, the only figure reported.
 */
export function reportedUsageCost(usage: unknown): number | string | undefined {
  const record = asUsageRecord(usage);
  if (!record) return undefined;
  const cost = usageCostValue(record.cost);
  const details = asUsageRecord(record.cost_details);
  const upstream = usageCostValue(details?.upstream_inference_cost);
  const byok = record.is_byok === true;
  if (byok && upstream !== undefined) {
    const total = Number(cost ?? 0) + Number(upstream);
    if (Number.isFinite(total)) return total;
  }
  return cost ?? upstream;
}

function isCostOnlyTrailer(chunk: any, isProviderTrailer?: (chunk: any) => boolean): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const hasEmptyChoices = !chunk.choices || (Array.isArray(chunk.choices) && chunk.choices.length === 0);
  if (!hasEmptyChoices) return false;
  if (chunk.usage != null) return false;
  return typeof chunk.cost === 'string' || isProviderTrailer?.(chunk) === true;
}

function createNormalizedReasoningStream(
  stream: AsyncIterable<any>,
  loggingService?: ILoggingService,
  costCapture?: CostTrailerCapture,
  isProviderTrailer?: (chunk: any) => boolean,
): AsyncIterable<any> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          let result = await iterator.next();
          while (!result.done && isCostOnlyTrailer(result.value, isProviderTrailer)) {
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
          }
          return result;
        },
      };
    },
  };
}

/**
 * Intercepts response stream metadata for OpenAI-compatible client calls.
 *
 * Wire fields (`reasoning_content` vs `reasoning`) are preserved verbatim.
 * Cost-only trailers are intercepted: the reported USD charge is captured into
 * `costCapture` (billing metadata) while the trailer itself is kept out of the
 * SDK usage accumulator.
 */
export function applyClientResponseNormalization(
  client: OpenAI,
  loggingService?: ILoggingService,
  costCapture?: CostTrailerCapture,
  isProviderTrailer?: (chunk: any) => boolean,
): void {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions) as (...args: any[]) => any;

  (client.chat.completions as any).create = async (...args: any[]) => {
    if (costCapture) delete costCapture.cost;
    const result = await originalCreate(...args);

    if (!result || typeof result !== 'object') return result;

    if (Array.isArray(result.choices)) return result;

    if (typeof result[Symbol.asyncIterator] === 'function') {
      return createNormalizedReasoningStream(result, loggingService, costCapture, isProviderTrailer);
    }

    return result;
  };
}
