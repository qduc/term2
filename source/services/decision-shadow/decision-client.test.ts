import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterDecisionClient, readDecisionErrorMetadata } from './decision-client.js';

describe('OpenRouter decision client', () => {
  it('normalizes answers, resolved model, and a provider-reported cost', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'typesafe/jev-1.13',
            cost: '0.00002772',
            answers: { case: { type: 'choice', choice: 'tool_0', confidence: 0.9 } },
          }),
          { status: 200 },
        ),
    );
    const client = createOpenRouterDecisionClient({
      resolveTransport: () => ({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' }),
      fetchImpl,
    });

    await expect(
      client.decide({
        model: '~typesafe/jev-latest',
        state: { request: 'inspect a file' },
        questions: { case: { type: 'choice', instructions: 'Pick one', criteria: { tool_0: 'read it' } } },
      }),
    ).resolves.toEqual({
      answers: { case: { type: 'choice', choice: 'tool_0', confidence: 0.9 } },
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 28,
    });
  });

  it('reports absent cost as unknown instead of zero', async () => {
    const client = createOpenRouterDecisionClient({
      resolveTransport: () => ({ apiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    });

    const result = await client.decide({ model: 'jev', state: {}, questions: {} });
    expect(result.costUsdMicros).toBeUndefined();
  });

  it('retains response model and cost when rejecting a malformed answer map', async () => {
    const client = createOpenRouterDecisionClient({
      resolveTransport: () => ({ apiKey: 'test-key' }),
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ model: 'typesafe/jev-1.13', usage: { cost: '0.000004' }, answers: [] }), {
            status: 200,
          }),
      ),
    });

    await expect(client.decide({ model: 'jev', state: {}, questions: {} })).rejects.toMatchObject({
      name: 'DecisionEvaluationError',
      code: 'invalid_response',
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 4,
    });
  });

  it('retains safe transport diagnostics from a failed HTTP response', async () => {
    const client = createOpenRouterDecisionClient({
      resolveTransport: () => ({ apiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => new Response('credential-shaped secret', { status: 429 })),
    });

    const error = await client.decide({ model: 'jev', state: {}, questions: {} }).catch((cause) => cause);

    expect(readDecisionErrorMetadata(error)).toEqual({
      errorType: 'OpenRouterDecisionError',
      errorCode: 'http_error',
      httpStatus: 429,
    });
    expect(JSON.stringify(readDecisionErrorMetadata(error))).not.toContain('credential-shaped secret');
  });
});
