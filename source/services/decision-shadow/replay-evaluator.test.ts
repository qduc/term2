import { expect, it, vi } from 'vitest';
import type { DecisionClient } from './decision-client.js';
import { FAILURE_TRIAGE_REPLAY_FIXTURES, TOOL_SELECTION_REPLAY_FIXTURES } from './replay-fixtures.js';
import { evaluateReplayFixtures } from './replay-evaluator.js';

it('keeps replay labels outside the evidence sent through live builders', async () => {
  const decide = vi.fn(async (request) => {
    if ('tools' in (request.state as Record<string, unknown>)) {
      return {
        answers: { case: { type: 'choice', choice: 'tool_0', confidence: 1 } },
        resolvedModel: 'typesafe/jev-1.13',
        costUsdMicros: 3,
      };
    }
    return {
      answers: {
        category: { type: 'choice', choice: 'TRANSIENT_PROVIDER', confidence: 1 },
        retry: { type: 'choice', choice: 'RETRY', confidence: 1 },
      },
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 5,
    };
  });
  const ticks = [10, 15, 20, 28];
  const result = await evaluateReplayFixtures({
    client: { decide } as DecisionClient,
    model: 'jev',
    toolSelection: TOOL_SELECTION_REPLAY_FIXTURES.slice(0, 1),
    failureTriage: FAILURE_TRIAGE_REPLAY_FIXTURES.slice(0, 1),
    now: () => ticks.shift()!,
  });

  expect(result).toMatchObject({ total: 2, correct: 2 });
  expect(result.errors).toBeUndefined();
  expect(result.cases).toEqual([
    {
      fixtureId: TOOL_SELECTION_REPLAY_FIXTURES[0]!.id,
      kind: 'tool_selection',
      promptVersion: 'tool-selection-v2-runtime-catalog',
      requestedModel: 'jev',
      resolvedModel: 'typesafe/jev-1.13',
      latencyMs: 5,
      cost: 3,
      expected: { selectedToolId: 'direct:read_file' },
      prediction: { selectedToolId: 'direct:read_file', confidence: 1 },
      correct: true,
    },
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
  const ticks = [100, 107, 200, 211];
  const result = await evaluateReplayFixtures({
    client: {
      decide: async (request) =>
        'tools' in (request.state as Record<string, unknown>)
          ? {
              answers: { case: { type: 'choice', choice: 'not_a_runtime_token', confidence: 1 } },
              resolvedModel: 'typesafe/jev-1.13',
              costUsdMicros: 7,
            }
          : {
              answers: { category: { type: 'choice', choice: 'UNKNOWN_CAUSE', confidence: 0.5 } },
              resolvedModel: 'typesafe/jev-1.13',
              costUsdMicros: 9,
            },
    },
    model: 'jev',
    toolSelection: TOOL_SELECTION_REPLAY_FIXTURES.slice(0, 1),
    failureTriage: FAILURE_TRIAGE_REPLAY_FIXTURES.slice(0, 1),
    now: () => ticks.shift()!,
  });

  expect(result.total).toBe(2);
  expect(result.correct).toBe(0);
  expect(result.errors).toEqual([
    expect.objectContaining({
      fixtureId: TOOL_SELECTION_REPLAY_FIXTURES[0]!.id,
      error: 'Invalid decision answer case',
    }),
    expect.objectContaining({
      fixtureId: FAILURE_TRIAGE_REPLAY_FIXTURES[0]!.id,
      error: 'Invalid decision answer retry',
    }),
  ]);
  expect(result.cases).toEqual([
    expect.objectContaining({
      fixtureId: TOOL_SELECTION_REPLAY_FIXTURES[0]!.id,
      kind: 'tool_selection',
      promptVersion: 'tool-selection-v2-runtime-catalog',
      requestedModel: 'jev',
      resolvedModel: 'typesafe/jev-1.13',
      latencyMs: 7,
      cost: 7,
      expected: { selectedToolId: 'direct:read_file' },
      correct: false,
      error: { name: 'DecisionEvaluationError', code: 'invalid_choice' },
    }),
    expect.objectContaining({
      fixtureId: FAILURE_TRIAGE_REPLAY_FIXTURES[0]!.id,
      kind: 'failure_triage',
      promptVersion: 'failure-triage-v2-runtime-evidence',
      requestedModel: 'jev',
      resolvedModel: 'typesafe/jev-1.13',
      latencyMs: 11,
      cost: 9,
      expected: { category: 'TRANSIENT_PROVIDER', retry: 'RETRY' },
      correct: false,
      error: { name: 'DecisionEvaluationError', code: 'invalid_choice' },
    }),
  ]);
});
