import test from 'ava';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { OpenAIResponsesModelWithPromptCacheKey, TimedOpenAIResponsesWSModel } from './openai.provider.js';

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

test.serial('TimedOpenAIResponsesWSModel forwards prompt_cache_key from modelSettings', (t) => {
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
    const model = new TimedOpenAIResponsesWSModel({} as any, 'gpt-4o', {
      connectTimeoutMs: 1,
      idleTimeoutMs: 1,
    });
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
