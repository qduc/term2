import test from 'ava';
import { adaptAiSdkModelForAgents, withForwardedReasoningSettings } from './ai-sdk-agents-adapter.js';

test('withForwardedReasoningSettings forwards reasoning into providerData for non-stream requests', async (t) => {
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

  t.deepEqual(seenRequest.modelSettings.providerData, {
    service_tier: 'flex',
    reasoning: { effort: 'high', summary: 'auto' },
  });
  t.deepEqual(originalRequest.modelSettings.providerData, { service_tier: 'flex' });
});

test('withForwardedReasoningSettings forwards reasoning into providerData for streamed requests', async (t) => {
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

  t.deepEqual(seenRequest.modelSettings.providerData, {
    reasoning: { effort: 'low', summary: 'auto' },
  });
});

test('withForwardedReasoningSettings preserves explicit providerData reasoning', async (t) => {
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

  t.is(seenRequest.modelSettings.providerData.reasoning, providerReasoning);
});

test('adaptAiSdkModelForAgents makes reasoning visible to AI SDK doStream options', async (t) => {
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

  t.deepEqual(seenOptions.reasoning, { effort: 'high', summary: 'auto' });
});

test('adaptAiSdkModelForAgents forwards OpenRouter reasoning through providerOptions', async (t) => {
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

  t.deepEqual(seenOptions.providerOptions.openrouter.reasoning, {
    effort: 'none',
    summary: 'auto',
  });
  t.is(seenOptions.providerOptions.openrouter.service_tier, 'flex');
  t.is(seenOptions.service_tier, 'flex');
});

test('adaptAiSdkModelForAgents forwards OpenRouter service tier without reasoning', async (t) => {
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

  t.is(seenOptions.providerOptions.openrouter.service_tier, 'flex');
  t.false('reasoning' in seenOptions.providerOptions.openrouter);
});
