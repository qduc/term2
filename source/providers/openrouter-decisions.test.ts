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

  it('preserves a configured proxy path when targeting the decisions endpoint', async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    );
    await requestOpenRouterDecisions({
      model: 'jev',
      state: {},
      questions: {},
      apiKey: 'test-key',
      baseUrl: 'https://proxy.example/openrouter/api/v1',
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://proxy.example/openrouter/api/alpha/decisions');
  });

  it('rejects failed HTTP responses without returning decisions', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream detail', { status: 503 }));
    await expect(
      requestOpenRouterDecisions({ model: 'jev', state: {}, questions: {}, apiKey: 'test-key', fetchImpl }),
    ).rejects.toThrow('503');
  });

  it('aborts a stalled decision request at its deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const pending = requestOpenRouterDecisions({
        model: 'jev',
        state: {},
        questions: {},
        apiKey: 'test-key',
        fetchImpl,
        timeoutMs: 20,
      });
      const rejected = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(19);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
