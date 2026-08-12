import { expect, it, vi } from 'vitest';
import type { ProviderInputItem } from '../../../contracts/provider-input.js';
import { LocalContextCompactor } from './local-context-compactor.js';

const turns = (count: number, size = 100): ProviderInputItem[] =>
  Array.from({ length: count }, (_, index) => [
    { role: 'user', type: 'message', content: `user-${index}-${'x'.repeat(size)}` },
    { role: 'assistant', type: 'message', content: `answer-${index}` },
  ]).flat();

it('reduces cold turns sequentially and returns a marked checkpoint plus verbatim hot tail', async () => {
  const history = turns(6, 4_000);
  const generate = vi
    .fn()
    .mockResolvedValueOnce({ text: 'summary one', usage: { inputTokens: 10, outputTokens: 2 } })
    .mockResolvedValueOnce({ text: 'summary two', usage: { inputTokens: 12, outputTokens: 2 } });
  const compactor = new LocalContextCompactor({ generate });

  const outcome = await compactor.compactAtBoundary({
    history,
    provider: 'openrouter',
    model: 'test-model',
    sourceRevision: 7,
    contextWindow: 8_000,
    maxOutputTokens: 500,
    compactThreshold: 0.2,
    compactThresholdTokens: null,
    manual: true,
  });

  expect(outcome.kind).toBe('compacted');
  if (outcome.kind !== 'compacted') return;
  expect(generate).toHaveBeenCalledTimes(2);
  for (const call of generate.mock.calls) expect(() => JSON.parse(call[0].transcriptChunk)).not.toThrow();
  expect(generate.mock.calls[1]![0].priorSummary).toBe('summary one');
  expect(outcome.checkpoint).toMatchObject({
    role: 'system',
    type: 'message',
    contextSummary: { version: 1, strategy: 'local', replacesThroughRevision: 7 },
  });
  expect(outcome.hotTail).toEqual(history.slice(-4));
  expect(outcome.usage).toEqual({ inputTokens: 22, outputTokens: 4 });
});

it('does not call the generator below threshold in automatic mode', async () => {
  const generate = vi.fn();
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history: turns(3),
    provider: 'openrouter',
    model: 'test-model',
    sourceRevision: 1,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: false,
  });
  expect(outcome.kind).toBe('not_needed');
  expect(generate).not.toHaveBeenCalled();
});

it('returns blocked without a summary request when no cold turn exists', async () => {
  const generate = vi.fn();
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history: turns(2),
    provider: 'openrouter',
    model: 'test-model',
    sourceRevision: 1,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: true,
  });
  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'no_complete_cold_turn' });
  expect(generate).not.toHaveBeenCalled();
});

it('fails before generation for an uncatalogued model without a raw threshold', async () => {
  const generate = vi.fn();
  await expect(
    new LocalContextCompactor({ generate }).compactAtBoundary({
      history: turns(4),
      provider: 'custom',
      model: 'unknown',
      sourceRevision: 1,
      maxOutputTokens: 1_000,
      compactThreshold: 0.8,
      compactThresholdTokens: null,
      manual: true,
    }),
  ).rejects.toThrow('compactThresholdTokens');
  expect(generate).not.toHaveBeenCalled();
});

it('fails closed instead of exposing provider-opaque history to the summarizer', async () => {
  const generate = vi.fn();
  const history = [
    ...turns(2),
    {
      type: 'compaction',
      encrypted_content: 'secret-ciphertext',
      providerOpaque: { provider: 'openai' },
    },
    ...turns(3),
  ];
  await expect(
    new LocalContextCompactor({ generate }).compactAtBoundary({
      history,
      provider: 'openai',
      model: 'gpt-5',
      sourceRevision: 1,
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      compactThreshold: 0.8,
      compactThresholdTokens: null,
      manual: true,
    }),
  ).rejects.toThrow('provider-opaque');
  expect(generate).not.toHaveBeenCalled();
});

it('uses the existing local checkpoint as the running-summary seed on a later compaction', async () => {
  const generate = vi.fn(async () => ({ text: 'updated summary' }));
  const checkpoint: ProviderInputItem = {
    role: 'system',
    type: 'message',
    content: 'envelope\n<summary>prior exact summary</summary>',
    contextSummary: { version: 1, strategy: 'local' },
  };
  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history: [checkpoint, ...turns(3)],
    provider: 'openrouter',
    model: 'test-model',
    sourceRevision: 2,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: true,
  });
  expect(outcome.kind).toBe('compacted');
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ priorSummary: 'prior exact summary' }));
  const firstCall = generate.mock.calls[0] as unknown as [{ transcriptChunk: string }];
  expect(firstCall[0].transcriptChunk).not.toContain('contextSummary');
});
