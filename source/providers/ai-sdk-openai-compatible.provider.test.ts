import test from 'ava';
import { AiSdkOpenAICompatibleProvider } from './ai-sdk-openai-compatible.provider.js';

test('AiSdkOpenAICompatibleProvider creates an AI SDK model with resolved settings', (t) => {
  const calls: any[] = [];
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Example',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
      headers: {
        'X-Test': 'yes',
      },
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) => {
        requestedModel = modelId;
        return {
          specificationVersion: 'v3',
          provider: 'example.chat',
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any;
      };
    },
  });

  const model = provider.getModel('selected-model');

  t.is(calls.length, 1);
  t.like(calls[0], {
    name: 'Example',
    baseURL: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: {
      'X-Test': 'yes',
    },
  });
  t.is(requestedModel, 'selected-model');
  t.is(typeof (model as any).getResponse, 'function');
  t.is(typeof (model as any).getStreamedResponse, 'function');
});

test('AiSdkOpenAICompatibleProvider uses the default model when none is requested', (t) => {
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Example',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
    }),
    createProvider: () => (modelId: string) => {
      requestedModel = modelId;
      return {
        specificationVersion: 'v3',
        provider: 'example.chat',
        modelId,
        supportedUrls: {},
        doGenerate: async () => ({}),
        doStream: async () => ({ stream: [] }),
      } as any;
    },
  });

  provider.getModel();

  t.is(requestedModel, 'fallback-model');
});

test('AiSdkOpenAICompatibleProvider passes configured fetch to OpenAI-compatible provider', (t) => {
  const fetchImpl = async () => new Response('{}');
  const calls: any[] = [];
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Example',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
      fetch: fetchImpl,
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: 'example.chat',
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any);
    },
  });

  provider.getModel('selected-model');

  t.is(calls[0].fetch, fetchImpl);
});
