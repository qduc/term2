import { expect, it } from 'vitest';
import { AiSdkGoogleProvider } from '../../src/model/providers/ai-sdk-google.provider.js';
import { fixtureRequest } from './provider-wire-fixtures.js';
import { startFakeProviderHttpServer } from './fake-provider-http-server.js';

// Real adapter -> installed Google SDK -> loopback HTTP, including serialization.
it.each([
  { id: 'gemini-4-argon', effort: 'low', expected: { thinkingLevel: 'low', includeThoughts: true } },
  { id: 'gemini-4-carbon', effort: 'medium', expected: { thinkingLevel: 'medium', includeThoughts: true } },
  { id: 'models/gemini-4-argon', effort: 'high', expected: { thinkingLevel: 'high', includeThoughts: true } },
  { id: 'gemini-3.1-pro-preview', effort: 'minimal', expected: { thinkingLevel: 'low', includeThoughts: true } },
  { id: 'gemini-3.8-flash', effort: 'xhigh', expected: { thinkingLevel: 'high', includeThoughts: true } },
  { id: 'gemini-2.5-pro', effort: 'low', expected: { thinkingBudget: 2048, includeThoughts: true } },
  { id: 'gemini-3-pro-preview', effort: 'medium', expected: { thinkingBudget: 4096, includeThoughts: true } },
  { id: 'gemini-3-profiler', effort: 'low', expected: { thinkingBudget: 2048, includeThoughts: true } },
  { id: 'gemini-3-flashback', effort: 'low', expected: { thinkingBudget: 2048, includeThoughts: true } },
  { id: 'gemini-fixture', effort: 'high', expected: { thinkingBudget: 8192, includeThoughts: true } },
  { id: 'gemini-pro-latest', effort: 'medium', expected: { thinkingBudget: 4096, includeThoughts: true } },
  { id: 'gemini-4-argon', effort: undefined, expected: undefined },
  { id: 'gemini-4-argon', effort: 'none', expected: undefined },
  {
    id: 'gemini-4-argon',
    effort: 'high',
    options: { google: { thinkingConfig: { thinkingBudget: 6000, includeThoughts: false } } },
    expected: { thinkingBudget: 6000, includeThoughts: false },
  },
])('serializes caller effort on $id ($effort)', async ({ id, effort, options, expected }) => {
  const server = await startFakeProviderHttpServer({ protocol: 'google', scenario: 'success' });
  try {
    const provider = new AiSdkGoogleProvider({
      defaultModel: 'gemini-2.5-pro',
      resolveConfig: () => ({ apiKey: 'fixture', baseURL: server.baseUrl + '/v1beta' }),
    });
    const events = [];
    for await (const event of provider.getStreamedModel(id).stream({
      ...fixtureRequest,
      reasoning: { effort },
      maxTokens: 1234,
      providerOptions: options,
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'completion' });
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]!.body as any;
    expect(body.generationConfig.thinkingConfig).toEqual(expected);
    expect(body.generationConfig.maxOutputTokens).toBe(1234);
    expect(body.tools[0].functionDeclarations[0].name).toBe('fixture');
  } finally {
    await server.close();
  }
});

it('retains a provider rejection with native thinking settings', async () => {
  const server = await startFakeProviderHttpServer({ protocol: 'google', scenario: 'context-overflow' });
  try {
    const provider = new AiSdkGoogleProvider({
      defaultModel: 'gemini-4-argon',
      resolveConfig: () => ({ apiKey: 'fixture', baseURL: server.baseUrl + '/v1beta' }),
    });
    await expect(async () => {
      for await (const _event of provider.getStreamedModel().stream(fixtureRequest)) {
        /* consume */
      }
    }).rejects.toMatchObject({ statusCode: 400, responseBody: expect.stringContaining('Injected capacity rejection') });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } },
    });
  } finally {
    await server.close();
  }
});
