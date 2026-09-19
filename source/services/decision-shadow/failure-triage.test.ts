import { describe, expect, it, vi } from 'vitest';
import type { DecisionClient } from './decision-client.js';
import { FAILURE_TRIAGE_PROMPT_VERSION, evaluateFailureTriage, type FailureTriageEvidence } from './failure-triage.js';

const evidence: FailureTriageEvidence = {
  requestId: 'req-9',
  provider: 'openrouter',
  model: 'test-model',
  tier: 'standard',
  status: 429,
  code: 'rate_limit',
  retryAfterMs: 2000,
  message: 'Provider returned HTTP 429',
  transport: { errorName: 'OpenRouterError' },
};

describe('failure-triage decision', () => {
  it('keeps classifier labels and observed outcomes outside prediction state', async () => {
    const decide = vi.fn(async (_request: Parameters<DecisionClient['decide']>[0]) => ({
      answers: {
        category: { type: 'choice', choice: 'TRANSIENT_PROVIDER', confidence: 0.9 },
        retry: { type: 'choice', choice: 'RETRY', confidence: 0.75 },
      },
    }));
    const result = await evaluateFailureTriage({
      client: { decide } as DecisionClient,
      model: 'jev',
      evidence,
    });

    expect(result).toMatchObject({ category: 'TRANSIENT_PROVIDER', retry: 'RETRY', confidence: 0.75 });
    const state = decide.mock.calls[0]![0].state;
    expect(state).toEqual({ promptVersion: FAILURE_TRIAGE_PROMPT_VERSION, failure: evidence });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('retryable');
    expect(serialized).not.toContain('errorKind');
    expect(serialized).not.toContain('observedOutcome');
    expect(serialized).not.toContain('cancelled');
  });

  it('rejects incomplete retry answers instead of inventing a label', async () => {
    const client = {
      decide: async () => ({
        answers: { category: { type: 'choice', choice: 'UNKNOWN_CAUSE', confidence: 0.5 } },
        resolvedModel: 'typesafe/jev-1.13',
        costUsdMicros: 9,
      }),
    } as DecisionClient;
    await expect(evaluateFailureTriage({ client, model: 'jev', evidence })).rejects.toMatchObject({
      name: 'DecisionEvaluationError',
      code: 'invalid_choice',
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 9,
    });
  });
});
