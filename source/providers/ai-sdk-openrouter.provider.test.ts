import test from 'ava';
import { AiSdkOpenRouterProvider } from './ai-sdk-openrouter.provider.js';

test('AiSdkOpenRouterProvider creates an AI SDK model with OpenRouter settings', (t) => {
  const calls: any[] = [];
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({
      baseURL: 'https://openrouter.test/api/v1',
      apiKey: 'sk-test',
      headers: {
        'HTTP-Referer': 'https://term2.test',
        'X-Title': 'term2',
      },
      appName: 'term2',
      appUrl: 'https://term2.test',
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) => {
        requestedModel = modelId;
        return {
          specificationVersion: 'v3',
          provider: 'openrouter.chat',
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any;
      };
    },
  });

  const model = provider.getModel('anthropic/claude-sonnet-4.5');

  t.is(calls.length, 1);
  t.like(calls[0], {
    baseURL: 'https://openrouter.test/api/v1',
    apiKey: 'sk-test',
    headers: {
      'HTTP-Referer': 'https://term2.test',
      'X-Title': 'term2',
    },
    appName: 'term2',
    appUrl: 'https://term2.test',
    compatibility: 'strict',
  });
  t.is(requestedModel, 'anthropic/claude-sonnet-4.5');
  t.is(typeof (model as any).getResponse, 'function');
  t.is(typeof (model as any).getStreamedResponse, 'function');
});

test('AiSdkOpenRouterProvider uses the default model when none is requested', (t) => {
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({}),
    createProvider: () => (modelId: string) => {
      requestedModel = modelId;
      return {
        specificationVersion: 'v3',
        provider: 'openrouter.chat',
        modelId,
        supportedUrls: {},
        doGenerate: async () => ({}),
        doStream: async () => ({ stream: [] }),
      } as any;
    },
  });

  provider.getModel();

  t.is(requestedModel, 'openrouter/auto');
});

test('AiSdkOpenRouterProvider passes configured fetch to OpenRouter provider', (t) => {
  const fetchImpl = async () => new Response('{}');
  const calls: any[] = [];
  const provider = new AiSdkOpenRouterProvider({
    defaultModel: 'openrouter/auto',
    resolveConfig: () => ({
      fetch: fetchImpl,
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: 'openrouter.chat',
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
