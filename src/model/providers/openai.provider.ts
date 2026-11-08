import OpenAI from 'openai';
import {
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
} from './openai-responses-model.js';
import { registerProvider } from './registry.js';
import { createOpenAIModelCatalog } from './openai-model-catalog.js';
import { createProviderFetch } from './fetch/composer.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../traffic-context.js';

export {
  OpenAIResponsesModelWithPromptCacheKey,
  OpenAIResponsesWSModelWithPromptCacheKey,
} from './openai-responses-model.js';

const OPENAI_CAPABILITIES = {
  supportsFlexServiceTier: true,
  supportsConversationChaining: true,
  supportsContextCompaction: true,
  supportsPromptCacheKey: true,
  promptCacheKeyPlacement: 'responses-extra-body' as const,
  usesStrictToolSchema: true,
  nativePatchModelPrefixes: ['gpt-5.1'],
};

/**
 * Observe retries at the SDK transport boundary. OpenAI's fetch hook sees the
 * response before the SDK decides whether to retry, so response status alone
 * cannot distinguish a retryable final response from one followed by another
 * attempt. The SDK does expose its attempt number in this request header;
 * callback at the start of attempt N>0, where the next retry is actually
 * being dispatched. This also covers transport failures and emits nothing for
 * exhausted attempt N=0.
 */
export function createRetryAwareFetch(
  baseFetch: typeof fetch,
  onRetry: (() => void) | undefined,
  retryAttempts: number,
): typeof fetch {
  if (!onRetry || retryAttempts <= 0) return baseFetch;
  return (async (url: any, init?: any) => {
    const headers = init?.headers;
    const rawRetryCount =
      typeof headers?.get === 'function'
        ? headers.get('x-stainless-retry-count')
        : headers?.['x-stainless-retry-count'] ?? headers?.['X-Stainless-Retry-Count'];
    const retryCount = Number(rawRetryCount);
    if (Number.isInteger(retryCount) && retryCount > 0) onRetry();
    return baseFetch(url, init);
  }) as typeof fetch;
}

// Register OpenAI provider
registerProvider(
  {
    id: 'openai',
    label: 'OpenAI',
    createStreamedModel: (
      model,
      {
        settingsService,
        loggingService,
        sessionContextService,
        onRetry,
        retryAttempts,
        requestCapture,
        contextCompactionSessionState,
        onDispatched,
      },
    ) => {
      const defaultModel = settingsService.get('agent.modelSelection').model || 'gpt-4o';
      const resolvedModel = model || defaultModel;
      const apiKey = settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
      const configuredRetries = retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2;
      const openAIClient = new OpenAI({
        apiKey: apiKey || 'placeholder',
        maxRetries: configuredRetries,
        fetch: createRetryAwareFetch(
          createProviderFetch({
            providerId: 'openai',
            defaultModel,
            deps: {
              loggingService,
              sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
              onDispatched,
            },
          }),
          onRetry,
          configuredRetries,
        ),
      });

      const selectedModel =
        settingsService.get('agent.transport') === 'http'
          ? new OpenAIResponsesModelWithPromptCacheKey(
              openAIClient,
              resolvedModel,
              requestCapture,
              OPENAI_CAPABILITIES.supportsContextCompaction,
              contextCompactionSessionState,
            )
          : new OpenAIResponsesWSModelWithPromptCacheKey(
              openAIClient,
              resolvedModel,
              requestCapture,
              OPENAI_CAPABILITIES.supportsContextCompaction,
              contextCompactionSessionState,
            );
      return selectedModel;
    },
    fetchModels: createOpenAIModelCatalog(),
    clearConversations: undefined, // No conversation state to clear
    sensitiveSettingKeys: [],
    capabilities: OPENAI_CAPABILITIES,
  },
  { builtin: true },
);
