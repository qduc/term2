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
  for (const call of generate.mock.calls) expect(call[0].maxOutputTokens).toBe(500);
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

// A cold provider-opaque item is ciphertext describing a turn the checkpoint is
// about to replace. Preserving it would orphan it from the call it is paired
// with, which is a provider 400; summarizing it is impossible. Refusing to
// compact instead used to disable compaction permanently, because nothing but
// compaction ever removes such an item from history.
it('compacts past an encrypted provider-opaque item instead of refusing', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  const history = [
    ...turns(2),
    {
      type: 'compaction',
      encrypted_content: 'secret-ciphertext',
      providerOpaque: { provider: 'openai' },
    },
    ...turns(3),
  ];

  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history,
    provider: 'openai',
    model: 'gpt-5',
    sourceRevision: 1,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: true,
  });

  expect(outcome.kind).toBe('compacted');
  if (outcome.kind !== 'compacted') return;
  expect(outcome.droppedOpaqueItems).toBe(1);
  expect(generate).toHaveBeenCalled();
  for (const call of generate.mock.calls as unknown as [{ transcriptChunk: string }][]) {
    expect(call[0].transcriptChunk).not.toContain('secret-ciphertext');
  }
  expect(outcome.hotTail.some((item) => (item as { providerOpaque?: unknown }).providerOpaque !== undefined)).toBe(
    false,
  );
});

it('keeps a reasoning/tool-call pair and its result together on the hot side of the cut', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  // The last two genuine user turns form the hot tail. The middle turn carries a
  // full Responses-shaped pair, which must survive the cut intact: OpenAI rejects
  // a `function_call` without its `reasoning` item, and Gemini rejects a
  // `functionCall` whose thought signature was stripped.
  const history: ProviderInputItem[] = [
    { role: 'user', type: 'message', content: `first-${'x'.repeat(4_000)}` },
    { role: 'assistant', type: 'message', content: 'first answer' },
    { role: 'user', type: 'message', content: `second-${'x'.repeat(4_000)}` },
    { type: 'reasoning', id: 'rs_1', providerOpaque: { provider: 'openai' } },
    { type: 'function_call', callId: 'call_1', name: 'shell', arguments: '{}' },
    { type: 'function_call_result', callId: 'call_1', name: 'shell', output: 'ok' },
    { role: 'assistant', type: 'message', content: 'second answer' },
    { role: 'user', type: 'message', content: 'third' },
    { role: 'assistant', type: 'message', content: 'third answer' },
  ];

  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history,
    provider: 'openai',
    model: 'gpt-5',
    sourceRevision: 1,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: true,
  });

  expect(outcome.kind).toBe('compacted');
  if (outcome.kind !== 'compacted') return;
  const types = outcome.hotTail.map((item) => item.type ?? (item as { role?: string }).role);
  // Either the whole pair is hot or the whole pair is cold — never a call whose
  // reasoning or whose result landed on the other side.
  const hasCall = types.includes('function_call');
  const hasResult = types.includes('function_call_result');
  const hasReasoning = types.includes('reasoning');
  expect(hasResult).toBe(hasCall);
  expect(hasReasoning).toBe(hasCall);
});

it('blocks rather than emitting a hot tail whose tool result lost its call', async () => {
  const generate = vi.fn(async () => ({ text: 'summary' }));
  // A tool result placed directly after a genuine user message puts the cut
  // between a call and its result — the one shape the verbatim hot tail cannot
  // survive on any provider.
  const history: ProviderInputItem[] = [
    { role: 'user', type: 'message', content: `first-${'x'.repeat(4_000)}` },
    { role: 'assistant', type: 'message', content: 'first answer' },
    { role: 'user', type: 'message', content: `second-${'x'.repeat(4_000)}` },
    { type: 'function_call', callId: 'orphan', name: 'shell', arguments: '{}' },
    { role: 'user', type: 'message', content: 'third' },
    { type: 'function_call_result', callId: 'orphan', name: 'shell', output: 'ok' },
    { role: 'assistant', type: 'message', content: 'third answer' },
    { role: 'user', type: 'message', content: 'fourth' },
    { role: 'assistant', type: 'message', content: 'fourth answer' },
  ];

  const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
    history,
    provider: 'openai',
    model: 'gpt-5',
    sourceRevision: 1,
    contextWindow: 100_000,
    maxOutputTokens: 1_000,
    compactThreshold: 0.8,
    compactThresholdTokens: null,
    manual: true,
  });

  expect(outcome).toMatchObject({ kind: 'blocked', reason: 'hot_tail_would_orphan_tool_result' });
  expect(generate).not.toHaveBeenCalled();
});

it.each([
  ['reasoning', 'opaque provider reasoning that belongs to a completed cold turn'],
  ['reasoning_content', 'opaque provider reasoning that belongs to a completed cold turn'],
  [
    'reasoning_details',
    [{ type: 'reasoning_text', text: 'opaque provider reasoning that belongs to a completed cold turn' }],
  ],
] as const)(
  'compacts cold Chat Completions %s metadata without exposing it to the summarizer',
  async (field, value) => {
    const generate = vi.fn(async () => ({ text: 'summary' }));
    const history = [
      ...turns(2),
      {
        [field]: value,
        providerOpaque: { provider: 'opencode' },
      },
      ...turns(2),
    ];

    const outcome = await new LocalContextCompactor({ generate }).compactAtBoundary({
      history,
      provider: 'opencode',
      model: 'deepseek-v4-pro',
      sourceRevision: 1,
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      compactThreshold: 0.8,
      compactThresholdTokens: null,
      manual: true,
    });

    expect(outcome.kind).toBe('compacted');
    expect(generate).toHaveBeenCalledOnce();
    const firstCall = generate.mock.calls[0] as unknown as [{ transcriptChunk: string }];
    expect(firstCall[0].transcriptChunk).not.toContain('opaque provider reasoning');
  },
);

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
