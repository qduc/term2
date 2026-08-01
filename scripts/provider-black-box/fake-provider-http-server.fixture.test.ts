import { afterEach, describe, expect, it } from 'vitest';
import { readFixtureEnvelope } from './fixture-envelope.js';
import { startFakeProviderHttpServer } from './fake-provider-http-server.js';

let server: Awaited<ReturnType<typeof startFakeProviderHttpServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('fixture HTTP replay', () => {
  it('replays a recorded response and validates the outbound request', async () => {
    const fixture = await readFixtureEnvelope(
      new URL('./fixtures/fixture/fake_chat-completions_success.json', import.meta.url).pathname,
    );
    server = await startFakeProviderHttpServer({ fixture });
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture.turns[0]!.frames.find((frame) => frame.kind === 'http-request')!.body),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('[DONE]');
    server.assertReplayValid();
  });
  it('exposes a canonical diff for a request mutation', async () => {
    const fixture = await readFixtureEnvelope(
      new URL('./fixtures/fixture/fake_chat-completions_success.json', import.meta.url).pathname,
    );
    server = await startFakeProviderHttpServer({ fixture });
    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'mutated' }),
    });
    expect(server.comparisonFailures.join('\n')).toContain('mutated');
  });
});
