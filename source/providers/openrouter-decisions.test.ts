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
    ).rejects.toMatchObject({ name: 'OpenRouterDecisionError', code: 'configuration_error' });
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

  it('classifies an invalid base URL before contacting the provider', async () => {
    const fetchImpl = vi.fn();

    const error = await requestOpenRouterDecisions({
      model: 'jev',
      state: {},
      questions: {},
      apiKey: 'test-key',
      baseUrl: 'not a URL',
      fetchImpl,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: 'OpenRouterDecisionError', code: 'configuration_error' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects failed HTTP responses without returning decisions', async () => {
    const fetchImpl = vi.fn(async () => new Response('sensitive upstream detail', { status: 503 }));
    await expect(
      requestOpenRouterDecisions({ model: 'jev', state: {}, questions: {}, apiKey: 'test-key', fetchImpl }),
    ).rejects.toMatchObject({
      name: 'OpenRouterDecisionError',
      code: 'http_error',
      status: 503,
      message: 'OpenRouter Decisions returned HTTP 503',
    });
    await expect(
      requestOpenRouterDecisions({ model: 'jev', state: {}, questions: {}, apiKey: 'test-key', fetchImpl }),
    ).rejects.not.toThrow('sensitive upstream detail');
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
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'OpenRouterDecisionError',
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies fetch failures without retaining their messages', async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('request contained a secret')));

    const error = await requestOpenRouterDecisions({
      model: 'jev',
      state: {},
      questions: {},
      apiKey: 'test-key',
      fetchImpl,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: 'OpenRouterDecisionError', code: 'network_error' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret');
  });

  it('classifies invalid JSON without retaining response content', async () => {
    const fetchImpl = vi.fn(async () => new Response('private invalid response', { status: 200 }));

    const error = await requestOpenRouterDecisions({
      model: 'jev',
      state: {},
      questions: {},
      apiKey: 'test-key',
      fetchImpl,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: 'OpenRouterDecisionError', code: 'invalid_json' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private invalid response');
  });

  it('classifies a body read interrupted by the deadline as a timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('body contained a secret')));
          },
        });
        return new Response(body, { status: 200 });
      });
      const pending = requestOpenRouterDecisions({
        model: 'jev',
        state: {},
        questions: {},
        apiKey: 'test-key',
        fetchImpl,
        timeoutMs: 20,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: 'OpenRouterDecisionError',
        code: 'timeout',
      });

      await vi.advanceTimersByTimeAsync(20);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes response stream failures from invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('body contained a secret'));
        },
      });
      return new Response(body, { status: 200 });
    });

    const error = await requestOpenRouterDecisions({
      model: 'jev',
      state: {},
      questions: {},
      apiKey: 'test-key',
      fetchImpl,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: 'OpenRouterDecisionError', code: 'response_read_error' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret');
  });

  it('classifies request serialization before contacting the provider', async () => {
    const fetchImpl = vi.fn();
    const state: { self?: unknown } = {};
    state.self = state;

    const error = await requestOpenRouterDecisions({
      model: 'jev',
      state,
      questions: {},
      apiKey: 'test-key',
      fetchImpl,
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: 'OpenRouterDecisionError', code: 'request_serialization' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
