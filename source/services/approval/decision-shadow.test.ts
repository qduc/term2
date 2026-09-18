import { expect, it, vi } from 'vitest';
import { evaluateDecisionShadow } from './decision-shadow.js';

it('compares typed Jev classifications for each approval request', async () => {
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body.questions)).toEqual(['risk_0', 'authorization_0', 'risk_1', 'authorization_1']);
    expect(body.state).toEqual({
      policy: expect.any(String),
      evidence: {
        userRequest: 'release the next version',
        recentContext: 'request evidence',
        priorHumanDecisions: '(none this session)',
        requests: [
          { toolName: 'shell', command: 'pnpm test' },
          { toolName: 'shell', command: 'curl public API' },
        ],
      },
    });
    expect(body.questions.risk_0.instructions).toContain('`evidence.requests[0]`');
    expect(body.questions.authorization_1.instructions).toContain('`evidence.userRequest`');
    expect(body.questions.risk_0.criteria.low).toContain('public information retrieval');
    expect(body.questions.risk_0.criteria.high).toContain('network exfiltration');
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
    evidence: {
      userRequest: 'release the next version',
      recentContext: 'request evidence',
      priorHumanDecisions: '(none this session)',
      requests: [
        { toolName: 'shell', command: 'pnpm test' },
        { toolName: 'shell', command: 'curl public API' },
      ],
    },
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
      evidence: {
        userRequest: '',
        recentContext: 'request evidence',
        priorHumanDecisions: '',
        requests: [{ toolName: 'shell', command: 'pwd' }],
      },
      apiKey: 'test-key',
      fetchImpl,
    }),
  ).rejects.toThrow('authorization_0');
});
