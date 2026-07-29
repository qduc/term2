import { it, expect } from 'vitest';
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

it('OpenAI provider defaults to websocket and honors explicit HTTP transport', async () => {
  const provider = getProvider('openai');
  expect(provider?.createRunner).toBeTruthy();

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
    expect((model as any).wrappedModel instanceof expectedClass).toBe(true);
  }
});

it.sequential('OpenAIResponsesModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', () => {
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

    expect(built.requestData.prompt_cache_key).toBe('conv_123');
    expect(built.requestData.temperature).toBe(0.4);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('OpenAIResponsesWSModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', () => {
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

    expect(built.requestData.prompt_cache_key).toBe('conv_456');
    expect(built.requestData.temperature).toBe(0.4);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('OpenAI request capture records the exact post-builder HTTP and WebSocket request projection', () => {
  const captures: any[] = [];
  const capture = { record: (entry: any) => captures.push(entry) };
  const originalHttp = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  const originalWs = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
  const builder = function () {
    return { requestData: { input: [{ role: 'user', content: 'hello' }], previous_response_id: 'resp-1' } };
  };
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = builder;
  (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = builder;
  try {
    for (const ModelClass of [OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey]) {
      const model = new ModelClass({} as any, 'gpt-5', capture as any);
      (model as any)._buildResponsesCreateRequest({ modelSettings: { prompt_cache_key: 'cache-key' } }, true);
    }
    expect(captures).toEqual([
      expect.objectContaining({
        transport: 'http',
        requestData: {
          input: [{ role: 'user', content: 'hello' }],
          previous_response_id: 'resp-1',
          prompt_cache_key: 'cache-key',
        },
      }),
      expect.objectContaining({
        transport: 'websocket',
        requestData: {
          input: [{ role: 'user', content: 'hello' }],
          previous_response_id: 'resp-1',
          prompt_cache_key: 'cache-key',
        },
      }),
    ]);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalHttp;
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = originalWs;
  }
});
