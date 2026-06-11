import test from 'ava';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey } from './openai.provider.js';
import { getProvider } from './registry.js';

const loggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return null;
  },
} as any;

test('OpenAI provider defaults to websocket and honors explicit HTTP transport', async (t) => {
  const provider = getProvider('openai');
  t.truthy(provider?.createRunner);

  for (const [transport, expectedClass] of [
    [undefined, OpenAIResponsesWSModelWithPromptCacheKey],
    ['http', OpenAIResponsesModelWithPromptCacheKey],
  ] as const) {
    const runner = provider!.createRunner!({
      settingsService: {
        get(key: string) {
          if (key === 'agent.model') return 'gpt-4o';
          if (key === 'agent.transport') return transport;
          if (key === 'agent.retryAttempts') return 0;
          return undefined;
        },
      } as any,
      loggingService,
    });
    const model = await runner!.config.modelProvider!.getModel('gpt-4o');
    t.true((model as any).wrappedModel instanceof expectedClass);
  }
});

test.serial('OpenAIResponsesModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', (t) => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-4o');
    const built = (model as any)._buildResponsesCreateRequest(
      {
        modelSettings: {
          prompt_cache_key: 'conv_123',
        },
      },
      true,
    );

    t.is(built.requestData.prompt_cache_key, 'conv_123');
    t.is(built.requestData.temperature, 0.4);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

test.serial('OpenAIResponsesWSModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', (t) => {
  const original = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new OpenAIResponsesWSModelWithPromptCacheKey({} as any, 'gpt-4o');
    const built = (model as any)._buildResponsesCreateRequest(
      {
        modelSettings: {
          prompt_cache_key: 'conv_456',
        },
      },
      true,
    );

    t.is(built.requestData.prompt_cache_key, 'conv_456');
    t.is(built.requestData.temperature, 0.4);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});
