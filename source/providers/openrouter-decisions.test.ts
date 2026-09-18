import { describe, expect, it, vi } from 'vitest';
import { requestOpenRouterDecisions } from './openrouter-decisions.js';

describe('requestOpenRouterDecisions', () => {
  it('posts decision questions to the alpha endpoint with configured credentials', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ answers: { risk_0: { type: 'choice', choice: 'low' } } }), { status: 200 }),
    );
    const result = await requestOpenRouterDecisions({
      model: '~typesafe/jev-latest',
      state: { request: 'test' },
      questions: { risk_0: { type: 'choice', instructions: 'Classify risk', criteria: { low: 'low risk' } } },
      apiKey: 'test-key',
      baseUrl: 'https://example.test/api/v1',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/api/alpha/decisions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        body: JSON.stringify({
          model: '~typesafe/jev-latest',
          state: { request: 'test' },
          questions: { risk_0: { type: 'choice', instructions: 'Classify risk', criteria: { low: 'low risk' } } },
        }),
      }),
    );
    expect(result).toEqual({ answers: { risk_0: { type: 'choice', choice: 'low' } } });
  });

  it('rejects a missing key before sending a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestOpenRouterDecisions({ model: 'jev', state: {}, questions: {}, apiKey: '', fetchImpl }),
    ).rejects.toThrow('API key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects failed HTTP responses without returning decisions', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream detail', { status: 503 }));
    await expect(
      requestOpenRouterDecisions({ model: 'jev', state: {}, questions: {}, apiKey: 'test-key', fetchImpl }),
    ).rejects.toThrow('503');
  });
});
