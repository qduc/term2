import test from 'ava';
import { AiSdkOpenAICompatibleProvider } from './ai-sdk-openai-compatible.provider.js';

test('AiSdkOpenAICompatibleProvider creates an AI SDK model with resolved settings', (t) => {
  const calls: any[] = [];
  let requestedModel: string | undefined;
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Example',
    providerType: 'example',
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
    name: 'example',
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

test('AiSdkOpenAICompatibleProvider uses provider type for AI SDK provider name', (t) => {
  const calls: any[] = [];
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Local Display Name',
    providerType: 'lmstudio',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: `${options.name}.chat`,
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any);
    },
  });

  provider.getModel('selected-model');

  t.is(calls[0].name, 'lmstudio');
});

test('AiSdkOpenAICompatibleProvider defaults provider type for old configs', (t) => {
  const calls: any[] = [];
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Local Display Name',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
    }),
    createProvider: (options: any) => {
      calls.push(options);
      return (modelId: string) =>
        ({
          specificationVersion: 'v3',
          provider: `${options.name}.chat`,
          modelId,
          supportedUrls: {},
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: [] }),
        } as any);
    },
  });

  provider.getModel('selected-model');

  t.is(calls[0].name, 'openai-compatible');
});

test('AiSdkOpenAICompatibleProvider forwards provider type to adapter for providerOptions keys', async (t) => {
  let seenOptions: any;
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Local Display Name',
    providerType: 'lmstudio',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
    }),
    createProvider: (options: any) => () =>
      ({
        specificationVersion: 'v3',
        provider: `${options.name}.chat`,
        modelId: 'selected-model',
        supportedUrls: {},
        doGenerate: async () => ({ content: [], usage: {} }),
        doStream: async (options: any) => {
          seenOptions = options;
          return { stream: (async function* () {})() };
        },
      } as any),
  });

  const model = provider.getModel('selected-model') as any;

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      providerData: { service_tier: 'flex' },
    },
  } as any)) {
    // Consume the stream.
  }

  t.is(seenOptions.providerOptions.lmstudio.service_tier, 'flex');
});

test('AiSdkOpenAICompatibleProvider matches AI SDK providerOptions key for dotted provider types', async (t) => {
  let seenOptions: any;
  const provider = new AiSdkOpenAICompatibleProvider({
    label: 'Local Display Name',
    providerType: 'llama.cpp',
    defaultModel: 'fallback-model',
    resolveConfig: () => ({
      baseURL: 'https://example.test/v1',
    }),
    createProvider: (options: any) => () =>
      ({
        specificationVersion: 'v3',
        provider: `${options.name}.chat`,
        modelId: 'selected-model',
        supportedUrls: {},
        doGenerate: async () => ({ content: [], usage: {} }),
        doStream: async (options: any) => {
          seenOptions = options;
          return { stream: (async function* () {})() };
        },
      } as any),
  });

  const model = provider.getModel('selected-model') as any;

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      providerData: { service_tier: 'flex' },
    },
  } as any)) {
    // Consume the stream.
  }

  t.is(seenOptions.providerOptions.llama.service_tier, 'flex');
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
