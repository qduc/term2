import OpenAI from 'openai';
import type { ILoggingService } from '../services/service-interfaces.js';

function normalizeMessageField(target: any): void {
  if (target && typeof target.reasoning_content === 'string' && typeof target.reasoning !== 'string') {
    target.reasoning = target.reasoning_content;
  }
}

function createNormalizedReasoningStream(
  stream: AsyncIterable<any>,
  loggingService?: ILoggingService,
): AsyncIterable<any> {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const result = await iterator.next();
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
 */
export function applyClientResponseNormalization(client: OpenAI, loggingService?: ILoggingService): void {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions) as (...args: any[]) => any;

  (client.chat.completions as any).create = async (...args: any[]) => {
    const result = await originalCreate(...args);

    if (!result || typeof result !== 'object') return result;

    if (Array.isArray(result.choices)) {
      for (const choice of result.choices) {
        normalizeMessageField(choice.message);
      }
      return result;
    }

    if (typeof result[Symbol.asyncIterator] === 'function') {
      return createNormalizedReasoningStream(result, loggingService);
    }

    return result;
  };
}
