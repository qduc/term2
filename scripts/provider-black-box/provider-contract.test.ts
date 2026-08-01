import { afterEach, describe, expect, it } from 'vitest';
import { getAllProviders, getProvider } from '../../source/providers/registry.js';
import '../../source/providers/index.js';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import { fixtureRequest, fixtureTool, multiTurnFixture } from './provider-wire-fixtures.js';

let server: FakeProviderHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('provider boundary black-box fixtures', () => {
  it('keeps the registered provider surface resolvable', () => {
    for (const id of ['openai', 'codex', 'openrouter']) {
      const provider = getProvider(id);
      expect(provider?.createStreamedModel, id).toBeTypeOf('function');
    }
    expect(getAllProviders().length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['chat-completions', { id: 'chatcmpl_fake', choices: [{ delta: { content: 'hello' } }] }],
    ['responses', { type: 'response.output_text.delta', delta: 'hello' }],
    ['anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }],
    ['google', { candidates: [{ content: { parts: [{ text: 'hello' }] } }] }],
  ] as const)('captures semantic %s wire traffic without snapshots', async (protocol, expectedFrame) => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol });
    const response = await fetch(server.baseUrl, { method: 'POST', body: JSON.stringify(fixtureRequest) });
    expect(response.ok).toBe(true);
    const body = await response.text();
    expect(body).toContain('hello');
    expect(body).toContain(
      protocol === 'responses'
        ? 'response.output_text.delta'
        : protocol === 'anthropic'
        ? 'content_block_delta'
        : protocol === 'google'
        ? 'candidates'
        : 'chatcmpl_fake',
    );
    expect(expectedFrame).toBeDefined();
    expect(server.requests[0]?.body).toMatchObject({ input: fixtureRequest.input });
  });

  it('preserves the shared tool and multi-turn fixture invariants', () => {
    expect(fixtureTool.name).toBe('fixture');
    expect(fixtureRequest.tools).toContainEqual(fixtureTool);
    expect(multiTurnFixture.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(multiTurnFixture.map((item) => item.content[0].text)).toEqual(['first', 'second', 'third']);
  });

  it.each(['error', 'early-close', 'incomplete'] as const)(
    'offers deterministic %s failure fixtures',
    async (scenario) => {
      server = await startFakeProviderHttpServer({ scenario });
      if (scenario === 'early-close') await expect(fetch(server.baseUrl, { method: 'POST' })).rejects.toThrow();
      else if (scenario === 'error') expect((await fetch(server.baseUrl, { method: 'POST' })).status).toBe(500);
      else expect(await (await fetch(server.baseUrl, { method: 'POST' })).text()).not.toContain('[DONE]');
    },
  );
});
