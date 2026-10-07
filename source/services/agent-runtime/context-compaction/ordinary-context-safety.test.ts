import { expect, it, vi } from 'vitest';
import type { ProviderInputItem } from '../../../contracts/provider-input.js';
import { LocalContextCompactor } from './local-context-compactor.js';
import { shouldDeferAutomaticCompaction } from './index.js';

const user: ProviderInputItem = {
  type: 'message',
  role: 'user',
  content: 'Implement ISSUE-739; preserve exact ID α-42. Do not publish or repeat completed writes.',
};
const round = (n: number, size = 3000): ProviderInputItem[] => [
  { type: 'function_call', callId: `effect-${n}`, name: 'write_file', arguments: JSON.stringify({ path: `out-${n}` }) },
  {
    type: 'function_call_result',
    callId: `effect-${n}`,
    name: 'write_file',
    output: `Observed receipt ${n} ${'x'.repeat(size)}`,
  },
];
const options = {
  provider: 'fixture',
  model: 'fixture',
  sourceRevision: 1,
  contextWindow: 16000,
  maxOutputTokens: 500,
  compactThreshold: 0.2,
  compactThresholdTokens: null,
  manual: false,
};

it('compacts closed rounds inside one user task while retaining its exact instructions and tool receipts', async () => {
  const history = [user, ...Array.from({ length: 8 }, (_, n) => round(n)).flat()];
  const original = structuredClone(history);
  const generate = vi.fn(async () => ({ text: 'An intentionally incomplete semantic summary.' }));
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({ ...options, history });
  expect(
    outcome.kind,
    JSON.stringify({ reason: 'reason' in outcome ? outcome.reason : undefined, estimate: outcome.estimate }),
  ).toBe('compacted');
  if (outcome.kind !== 'compacted') return;
  expect(outcome.hotTail).toContainEqual(user);
  expect(outcome.checkpoint.content).toContain('effect-0');
  expect(outcome.checkpoint.content).toContain('write_file');
  expect(outcome.hotTail).toContainEqual(history.at(-1));
  expect(history).toEqual(original);
});

it('rearms a same-user task after real growth instead of a lifetime cap or another human turn', () => {
  expect(
    shouldDeferAutomaticCompaction({
      automaticCompactionsThisRun: 4,
      checkpoint: { rearmAtEstimatedTokens: 5000 },
      renderedInputTokens: 5000,
      hasCompleteNewUserTurn: false,
    }),
  ).toBe(null);
  expect(
    shouldDeferAutomaticCompaction({
      automaticCompactionsThisRun: 4,
      checkpoint: { rearmAtEstimatedTokens: 5000 },
      renderedInputTokens: 4999,
      hasCompleteNewUserTurn: true,
    }),
  ).toBe('hysteresis');
});

it('triggers on instructions and schemas before the request ceiling, even with a large model window', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    contextWindow: 1_000_000,
    compactThreshold: 0.8,
    maxRequestInputTokens: 8000,
    history: [user, ...Array.from({ length: 8 }, (_, n) => round(n, 800)).flat()],
    instructions: 'I'.repeat(17000),
    tools: [{ description: 'T'.repeat(3000) }],
  });
  expect(
    outcome.kind,
    JSON.stringify({ reason: 'reason' in outcome ? outcome.reason : undefined, estimate: outcome.estimate }),
  ).toBe('compacted');
  expect(generate).toHaveBeenCalled();
});

it('bounds every rendered summary chunk even when one completed old turn is oversized', async () => {
  const sizes: number[] = [];
  const generate = vi.fn(async ({ renderedInput }) => {
    sizes.push(Buffer.byteLength(renderedInput));
    return { text: 'small summary' };
  });
  const history = [user, ...round(0, 100000), ...round(1, 100), ...round(2, 100)];
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    history,
    manual: true,
  });
  expect(
    outcome.kind,
    JSON.stringify({ reason: 'reason' in outcome ? outcome.reason : undefined, estimate: outcome.estimate }),
  ).toBe('compacted');
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.max(...sizes)).toBeLessThan(30000);
});

it('retains billed summary cost when the candidate does not fit', async () => {
  const cost = {
    requestId: 'summary-paid',
    provider: 'fixture',
    model: 'fixture',
    serviceTier: 'standard',
    outcome: 'completed',
    usdMicros: 100,
  } as const;
  const outcome = await new LocalContextCompactor({
    generate: async () => ({ text: 'x'.repeat(100000), costRecords: [cost] }),
  }).compactAtBoundary({
    ...options,
    history: [user, ...Array.from({ length: 8 }, (_, n) => round(n)).flat()],
    manual: true,
  });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'result_still_too_large', costRecords: [cost] });
});

it('refuses a non-reducing summary and preserves the original conversation and its costs', async () => {
  const history = [user, ...Array.from({ length: 8 }, (_, n) => round(n, 100)).flat()];
  const before = structuredClone(history);
  const cost = {
    requestId: 'nonreducing',
    provider: 'fixture',
    model: 'fixture',
    serviceTier: 'standard',
    outcome: 'completed',
    usdMicros: 250,
  } as const;
  const outcome = await new LocalContextCompactor({
    generate: async () => ({ text: 's'.repeat(7000), costRecords: [cost] }),
  }).compactAtBoundary({ ...options, history, manual: true });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'non_reducing', costRecords: [cost] });
  expect(history).toEqual(before);
});

it('checks prior summary and fixed summary instructions before dispatching another chunk', async () => {
  const generate = vi.fn(async (_input: { renderedInput: string }) => ({ text: 's'.repeat(25000) }));
  const history = [
    user,
    { type: 'message', role: 'assistant', content: 'very large old data'.repeat(10000) },
    ...round(0, 100),
    ...round(1, 100),
    ...round(2, 100),
  ] as ProviderInputItem[];
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    history,
    manual: true,
    maxRequestInputTokens: 3000,
    maxOutputTokens: 500,
  });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'summary_input_too_large' });
  expect(generate).toHaveBeenCalledTimes(1);
  const input = generate.mock.calls[0]![0] as { renderedInput: string };
  expect(Buffer.byteLength(input.renderedInput) / 4).toBeLessThan(3000);
});

it('refuses fixed instructions exceeding the ceiling without paying for a summary', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    history: [user, ...Array.from({ length: 8 }, (_, n) => round(n)).flat()],
    manual: true,
    maxRequestInputTokens: 3000,
    instructions: 'fixed'.repeat(3000),
  });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'single_turn_too_large' });
  expect(generate).not.toHaveBeenCalled();
});

it('uses the selected admission ceiling for an uncatalogued model without inventing its context window', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    contextWindow: undefined,
    maxRequestInputTokens: 6000,
    history: [user, ...Array.from({ length: 12 }, (_, n) => round(n)).flat()],
  });
  expect(
    outcome.kind,
    JSON.stringify({ reason: 'reason' in outcome ? outcome.reason : undefined, estimate: outcome.estimate }),
  ).toBe('compacted');
});

it('does not summarize a pending tool effect even across a new user message', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  const history = [
    user,
    { type: 'function_call', callId: 'pending', name: 'publish', arguments: '{}' },
    { type: 'message', role: 'user', content: 'correction' },
    { type: 'message', role: 'user', content: 'another correction' },
  ] as ProviderInputItem[];
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    ...options,
    history,
    manual: true,
  });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'no_complete_cold_turn' });
  expect(generate).not.toHaveBeenCalled();
});
