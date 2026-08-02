import { expect, it } from 'vitest';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
import { forwardExplicitProviderSettings, withForwardedProviderSettings } from './ai-sdk-provider-settings.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

const request = {
  input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  tools: [],
};

it.each([
  {
    name: 'Anthropic',
    provider: 'anthropic',
    family: 'anthropic' as const,
    providerOptions: { topK: 5, providerOptions: { anthropic: { topK: 9 } } },
    forward: (options: any) => forwardExplicitProviderSettings(options, 'anthropic'),
    expected: { topK: 5, providerOptions: { anthropic: { topK: 9 } } },
  },
  {
    name: 'Google',
    provider: 'google',
    family: 'google' as const,
    providerOptions: { safetySettings: ['outer'], providerOptions: { google: { safetySettings: ['nested'] } } },
    forward: (options: any) => forwardExplicitProviderSettings(options, 'google'),
    expected: { safetySettings: ['outer'], providerOptions: { google: { safetySettings: ['nested'] } } },
  },
])('$name forwards explicit provider settings for unary getResponse and streaming calls', async (fixture) => {
  const calls: any[] = [];
  const fakeModel = {
    specificationVersion: 'v3',
    provider: fixture.provider,
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate(options: any) {
      calls.push({ operation: 'generate', options });
      return {
        response: { id: 'unary-response' },
        text: 'unary',
        usage: { inputTokens: {}, outputTokens: {} },
      };
    },
    async doStream(options: any) {
      calls.push({ operation: 'stream', options });
      return {
        stream: (async function* () {
          yield { type: 'response-metadata', id: 'stream-response' };
          yield { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: {}, outputTokens: {} } };
        })(),
      };
    },
  } as any;

  const model = createAiSdkStreamedModel(
    withForwardedProviderSettings(fakeModel, fixture.forward as any),
    fixture.family,
  );
  const input = { ...request, providerOptions: fixture.providerOptions } as any;

  await model.getResponse!(input);
  await collect(model.stream!(input));

  expect(calls.map((call) => call.operation)).toEqual(['generate', 'stream']);
  expect(calls.map((call) => call.options)).toEqual([
    expect.objectContaining(fixture.expected),
    expect.objectContaining(fixture.expected),
  ]);
});
