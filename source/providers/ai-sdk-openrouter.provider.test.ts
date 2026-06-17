import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AiSdkOpenRouterProvider } from './ai-sdk-openrouter.provider.js';

it('AiSdkOpenRouterProvider creates an AI SDK model with OpenRouter settings', () => {
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

  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
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
  expect(requestedModel).toBe('anthropic/claude-sonnet-4.5');
  expect(typeof (model as any).getResponse).toBe('function');
  expect(typeof (model as any).getStreamedResponse).toBe('function');
});

it('AiSdkOpenRouterProvider uses the default model when none is requested', () => {
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

  expect(requestedModel).toBe('openrouter/auto');
});

it('AiSdkOpenRouterProvider passes configured fetch to OpenRouter provider', () => {
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

  expect(calls[0].fetch).toBe(fetchImpl);
});
