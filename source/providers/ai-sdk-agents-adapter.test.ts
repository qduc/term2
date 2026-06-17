import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { adaptAiSdkModelForAgents, withForwardedReasoningSettings } from './ai-sdk-agents-adapter.js';

it('withForwardedReasoningSettings forwards reasoning into providerData for non-stream requests', async () => {
  let seenRequest: any;
  const model = withForwardedReasoningSettings({
    async getResponse(request: any) {
      seenRequest = request;
      return { output: [], usage: {} };
    },
    async *getStreamedResponse() {},
  } as any);

  const originalRequest = {
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
      providerData: { service_tier: 'flex' },
    },
  };

  await model.getResponse(originalRequest as any);

  expect(seenRequest.modelSettings.providerData).toEqual({
    service_tier: 'flex',
    reasoning: { effort: 'high', summary: 'auto' },
  });
  expect(originalRequest.modelSettings.providerData).toEqual({ service_tier: 'flex' });
});

it('withForwardedReasoningSettings forwards reasoning into providerData for streamed requests', async () => {
  let seenRequest: any;
  const model = withForwardedReasoningSettings({
    async getResponse() {
      return { output: [], usage: {} };
    },
    async *getStreamedResponse(request: any) {
      seenRequest = request;
    },
  } as any);

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'low', summary: 'auto' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenRequest.modelSettings.providerData).toEqual({
    reasoning: { effort: 'low', summary: 'auto' },
  });
});

it('withForwardedReasoningSettings preserves explicit providerData reasoning', async () => {
  let seenRequest: any;
  const providerReasoning = { effort: 'medium' };
  const model = withForwardedReasoningSettings({
    async getResponse(request: any) {
      seenRequest = request;
      return { output: [], usage: {} };
    },
    async *getStreamedResponse() {},
  } as any);

  await model.getResponse({
    input: 'hi',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
      providerData: { reasoning: providerReasoning },
    },
  } as any);

  expect(seenRequest.modelSettings.providerData.reasoning).toBe(providerReasoning);
});

it('adaptAiSdkModelForAgents makes reasoning visible to AI SDK doStream options', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'example',
    modelId: 'model',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenOptions.reasoning).toEqual({ effort: 'high', summary: 'auto' });
});

it('adaptAiSdkModelForAgents forwards OpenRouter reasoning through providerOptions', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'openrouter.chat',
    modelId: 'openai/gpt-oss-120b',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

  for await (const _event of model.getStreamedResponse({
    input: 'hi',
    tools: [],
    handoffs: [],
    outputType: 'text',
    modelSettings: {
      reasoning: { effort: 'none', summary: 'auto' },
      providerData: { service_tier: 'flex' },
    },
  } as any)) {
    // Consume the stream.
  }

  expect(seenOptions.providerOptions.openrouter.reasoning).toEqual({
    effort: 'none',
    summary: 'auto',
  });
  expect(seenOptions.providerOptions.openrouter.service_tier).toBe('flex');
  expect(seenOptions.service_tier).toBe('flex');
});

it('adaptAiSdkModelForAgents forwards OpenRouter service tier without reasoning', async () => {
  let seenOptions: any;
  const model = adaptAiSdkModelForAgents({
    provider: 'openrouter.chat',
    modelId: 'openai/gpt-oss-120b',
    specificationVersion: 'v3',
    supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: {} }),
    doStream: async (options: any) => {
      seenOptions = options;
      return {
        stream: (async function* () {})(),
      };
    },
  });

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

  expect(seenOptions.providerOptions.openrouter.service_tier).toBe('flex');
  expect('reasoning' in seenOptions.providerOptions.openrouter).toBe(false);
});
