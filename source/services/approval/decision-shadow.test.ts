import { expect, it, vi } from 'vitest';
import { evaluateDecisionShadow } from './decision-shadow.js';

it('compares typed Jev classifications for each approval request', async () => {
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions)).toEqual(['risk_0', 'authorization_0', 'risk_1', 'authorization_1']);
    expect(body.state.evidence).toContain('request evidence');
    return new Response(
      JSON.stringify({
        answers: {
          risk_0: { type: 'choice', choice: 'low', confidence: 0.9 },
          authorization_0: { type: 'choice', choice: 'explicit', confidence: 0.8 },
          risk_1: { type: 'choice', choice: 'high', confidence: 0.95 },
          authorization_1: { type: 'choice', choice: 'implied', confidence: 0.85 },
        },
      }),
      { status: 200 },
    );
  });
  const results = await evaluateDecisionShadow({
    model: '~typesafe/jev-latest',
    evidence: 'request evidence',
    requestCount: 2,
    apiKey: 'test-key',
    fetchImpl,
  });
  expect(results).toEqual([
    { riskLevel: 'low', authorization: 'explicit', confidence: 0.8, wouldApprove: true },
    { riskLevel: 'high', authorization: 'implied', confidence: 0.85, wouldApprove: false },
  ]);
});

it('rejects incomplete answers instead of treating them as approval', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          answers: {
            risk_0: { type: 'choice', choice: 'low', confidence: 1 },
          },
        }),
        { status: 200 },
      ),
  );
  await expect(
    evaluateDecisionShadow({
      model: '~typesafe/jev-latest',
      evidence: 'request evidence',
      requestCount: 1,
      apiKey: 'test-key',
      fetchImpl,
    }),
  ).rejects.toThrow('authorization_0');
});
