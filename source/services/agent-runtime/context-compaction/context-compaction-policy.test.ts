import { describe, expect, it } from 'vitest';
import type { ProviderInputItem } from '../../../contracts/provider-input.js';
import {
  estimateContext,
  planLocalCompaction,
  rearmAtTokens,
  resolveCompactionThreshold,
  serializeColdPrefix,
  shouldDeferAutomaticCompaction,
} from './index.js';

describe('resolveCompactionThreshold', () => {
  it.each([
    { ratio: 0.8, raw: null, expected: 80_000, source: 'ratio' },
    { ratio: 0.8, raw: 60_000, expected: 60_000, source: 'tokens' },
    { ratio: 0.6, raw: 60_000, expected: 60_000, source: 'both' },
    { ratio: 0, raw: null, expected: 1_000, source: 'ratio' },
  ] as const)('resolves ratio/raw thresholds %#', ({ ratio, raw, expected, source }) => {
    const result = resolveCompactionThreshold({
      contextWindow: 100_000,
      compactThreshold: ratio,
      compactThresholdTokens: raw,
    });
    expect(result).toMatchObject({ available: true, effectiveThreshold: expected });
    if (result.available) expect(result.thresholdSource).toBe(source);
  });

  it('uses only an explicit raw threshold for uncatalogued models', () => {
    expect(resolveCompactionThreshold({ compactThreshold: 0.8, compactThresholdTokens: null })).toEqual({
      available: false,
      reason: 'uncatalogued_without_token_threshold',
    });
    expect(resolveCompactionThreshold({ compactThreshold: 0.8, compactThresholdTokens: 12_000 })).toMatchObject({
      available: true,
      effectiveThreshold: 12_000,
      thresholdSource: 'tokens',
    });
  });

  it.each([
    { compactThreshold: -0.1, compactThresholdTokens: null },
    { compactThreshold: Number.NaN, compactThresholdTokens: null },
    { compactThreshold: 0.8, compactThresholdTokens: 999 },
    { compactThreshold: 0.8, compactThresholdTokens: 1_000.5 },
  ])('rejects invalid settings %#', (input) => {
    expect(() => resolveCompactionThreshold(input)).toThrow();
  });
});

it('estimates rendered input separately from output and safety reserves', () => {
  const estimate = estimateContext({
    history: [{ role: 'user', type: 'message', content: 'é'.repeat(2_000) }],
    instructions: 'system',
    tools: [{ name: 'read', description: 'schema' }],
    contextWindow: 10_000,
    maxOutputTokens: 2_000,
  });
  expect(estimate.renderedInputTokens).toBeGreaterThan(1_000);
  expect(estimate.outputReserveTokens).toBe(2_000);
  expect(estimate.safetyReserveTokens).toBe(1_000);
  expect(estimate.hardFitTokens).toBe(estimate.renderedInputTokens + 3_000);
});

it('selects a cold prefix at a user boundary and preserves the two newest turns byte-for-byte', () => {
  const turn = (n: number): ProviderInputItem[] => [
    { role: 'user', type: 'message', content: `user-${n}` },
    { type: 'function_call', callId: `call-${n}`, name: 'read', arguments: '{}' },
    { type: 'function_call_result', callId: `call-${n}`, name: 'read', output: `result-${n}` },
    { role: 'assistant', type: 'message', content: `answer-${n}` },
  ];
  const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
  const original = structuredClone(history);
  const plan = planLocalCompaction({ history, usableInputTokens: 64_000 });

  expect(plan.kind).toBe('planned');
  if (plan.kind !== 'planned') return;
  expect(plan.coldPrefix).toEqual([...turn(1), ...turn(2)]);
  expect(plan.hotTail).toEqual([...turn(3), ...turn(4)]);
  expect(history).toEqual(original);
  expect(plan.hotTail.filter((item) => item.type === 'function_call_result')).toHaveLength(2);
});

it('does not cut when fewer than two protected turns plus one cold turn exist', () => {
  const history: ProviderInputItem[] = [
    { role: 'user', type: 'message', content: 'one' },
    { role: 'assistant', type: 'message', content: 'answer' },
    { role: 'user', type: 'message', content: 'two' },
  ];
  expect(planLocalCompaction({ history, usableInputTokens: 64_000 })).toEqual({
    kind: 'blocked',
    reason: 'no_complete_cold_turn',
  });
});

it('truncates old tool payloads for summarizer input without mutating source history', () => {
  const history: ProviderInputItem[] = [
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{bad' },
    { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'x'.repeat(30_000) },
  ];
  const original = structuredClone(history);
  const serialized = serializeColdPrefix(history, { maxToolResultCharacters: 1_000 });
  expect(serialized).toContain('truncated tool result');
  expect(serialized).toContain('call-1');
  expect(serialized.length).toBeLessThan(5_000);
  expect(history).toEqual(original);
});

it('rearms with the larger of 8000 tokens or ten percent of threshold', () => {
  expect(rearmAtTokens(2_000, 60_000)).toBe(10_000);
  expect(rearmAtTokens(2_000, 100_000)).toBe(12_000);
});

it('estimates context without inflating from internal bookkeeping fields or duplicate reasoning', () => {
  const baseHistory: ProviderInputItem[] = [
    { role: 'user', type: 'message', content: 'hello' },
    {
      type: 'reasoning',
      text: 'thinking-'.repeat(200),
    },
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'cat ' + 'x'.repeat(4_000) }),
    },
    {
      type: 'function_call_result',
      callId: 'call-1',
      name: 'shell',
      output: 'result-output-'.repeat(500),
    },
  ];
  const historyWithDuplicates: ProviderInputItem[] = [
    { role: 'user', type: 'message', content: 'hello' },
    {
      type: 'reasoning',
      text: 'thinking-'.repeat(200),
      providerMetadata: { reasoning_content: 'thinking-'.repeat(200) },
    },
    {
      type: 'provider_opaque',
      provider: 'deepseek',
      item: { reasoning_content: 'thinking-'.repeat(200) },
    },
    {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'cat ' + 'x'.repeat(4_000) }),
      providerItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'cat ' + 'x'.repeat(4_000) }),
      },
      rawItem: { foo: 'x'.repeat(4_000) },
    },
    {
      type: 'function_call_result',
      callId: 'call-1',
      name: 'shell',
      output: 'result-output-'.repeat(500),
      providerItem: {
        type: 'function_call_result',
        callId: 'call-1',
        name: 'shell',
        output: 'result-output-'.repeat(500),
      },
    },
  ];

  const baseEstimate = estimateContext({ history: baseHistory });
  const duplicateEstimate = estimateContext({ history: historyWithDuplicates });

  expect(duplicateEstimate.renderedInputTokens).toBe(baseEstimate.renderedInputTokens);
});

it('defers automatic compaction when blocked rearm is provided without a new user turn', () => {
  expect(
    shouldDeferAutomaticCompaction({
      automaticCompactionsThisRun: 0,
      rearmAtEstimatedTokens: 50_000,
      renderedInputTokens: 40_000,
      hasCompleteNewUserTurn: false,
    }),
  ).toBe('hysteresis');
  expect(
    shouldDeferAutomaticCompaction({
      automaticCompactionsThisRun: 0,
      rearmAtEstimatedTokens: 50_000,
      renderedInputTokens: 60_000,
      hasCompleteNewUserTurn: false,
    }),
  ).toBe('hysteresis');
  expect(
    shouldDeferAutomaticCompaction({
      automaticCompactionsThisRun: 0,
      rearmAtEstimatedTokens: 50_000,
      renderedInputTokens: 60_000,
      hasCompleteNewUserTurn: true,
    }),
  ).toBe(null);
});
