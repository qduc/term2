import { expect, it, vi } from 'vitest';
import { OpenRouterDecisionError } from '../../providers/openrouter-decisions.js';
import type { DecisionClient } from './decision-client.js';
import { FAILURE_TRIAGE_REPLAY_FIXTURES } from './replay-fixtures.js';
import { evaluateReplayFixtures } from './replay-evaluator.js';

it('keeps replay labels outside the evidence sent through live builders', async () => {
  const decide = vi.fn(async (_request: Parameters<DecisionClient['decide']>[0]) => ({
    answers: {
      category: { type: 'choice', choice: 'TRANSIENT_PROVIDER', confidence: 1 },
      retry: { type: 'choice', choice: 'RETRY', confidence: 1 },
    },
    resolvedModel: 'typesafe/jev-1.13',
    costUsdMicros: 5,
  }));
  const ticks = [10, 18];
  const result = await evaluateReplayFixtures({
    client: { decide } as DecisionClient,
    model: 'jev',
    failureTriage: FAILURE_TRIAGE_REPLAY_FIXTURES.slice(0, 1),
    now: () => ticks.shift()!,
  });

  expect(result).toMatchObject({ total: 1, correct: 1 });
  expect(result.errors).toBeUndefined();
  expect(result.cases).toEqual([
    {
      fixtureId: FAILURE_TRIAGE_REPLAY_FIXTURES[0]!.id,
      kind: 'failure_triage',
      promptVersion: 'failure-triage-v2-runtime-evidence',
      requestedModel: 'jev',
      resolvedModel: 'typesafe/jev-1.13',
      latencyMs: 8,
      cost: 5,
      expected: { category: 'TRANSIENT_PROVIDER', retry: 'RETRY' },
      prediction: { category: 'TRANSIENT_PROVIDER', retry: 'RETRY', confidence: 1 },
      correct: true,
    },
  ]);
  for (const call of decide.mock.calls) {
    expect(JSON.stringify(call[0].state)).not.toContain('expected');
  }
});

it('counts replay request and parse errors explicitly instead of omitting them', async () => {
  const ticks = [100, 111];
  const result = await evaluateReplayFixtures({
    client: {
      decide: async () => ({
        answers: { category: { type: 'choice', choice: 'UNKNOWN_CAUSE', confidence: 0.5 } },
        resolvedModel: 'typesafe/jev-1.13',
        costUsdMicros: 9,
      }),
    },
    model: 'jev',
    failureTriage: FAILURE_TRIAGE_REPLAY_FIXTURES.slice(0, 1),
    now: () => ticks.shift()!,
  });

  expect(result.total).toBe(1);
  expect(result.correct).toBe(0);
  expect(result.errors).toEqual([
    expect.objectContaining({
      fixtureId: FAILURE_TRIAGE_REPLAY_FIXTURES[0]!.id,
      error: 'Invalid decision answer retry',
    }),
  ]);
  expect(result.cases).toEqual([
    expect.objectContaining({
      fixtureId: FAILURE_TRIAGE_REPLAY_FIXTURES[0]!.id,
      kind: 'failure_triage',
      correct: false,
      error: { name: 'DecisionEvaluationError', code: 'invalid_choice' },
    }),
  ]);
});

it('retains HTTP status in replay failure diagnostics', async () => {
  const result = await evaluateReplayFixtures({
    client: {
      decide: async () => {
        throw new OpenRouterDecisionError('OpenRouter Decisions returned HTTP 503', 'http_error', { status: 503 });
      },
    },
    model: 'jev',
    failureTriage: FAILURE_TRIAGE_REPLAY_FIXTURES.slice(0, 1),
  });

  expect(result.cases).toEqual([
    expect.objectContaining({ error: { name: 'OpenRouterDecisionError', code: 'http_error', httpStatus: 503 } }),
  ]);
});
