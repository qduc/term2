import { it, expect, vi, afterEach } from 'vitest';
import { createResponseEventNormalizationState, normalizeResponseEvent } from './openai-responses-model.js';

// Frame shapes and timings below are the live measurements recorded as Round 4 in
// docs/plans/openai-context-compaction.md (gpt-5.6-luna, two runs): the streamed order is
// [compaction, message, compaction], the leading compaction closes in 13-16ms, and the
// trailing one takes 720-1376ms.

afterEach(() => {
  vi.useRealTimers();
});

const added = (outputIndex: number, id: string) => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { type: 'compaction', id, encrypted_content: 'ciphertext' },
});

const done = (outputIndex: number, id: string) => ({
  type: 'response.output_item.done',
  output_index: outputIndex,
  item: { type: 'compaction', id, encrypted_content: 'ciphertext' },
});

it('surfaces a compaction output item as a started event', () => {
  const state = createResponseEventNormalizationState();
  expect(normalizeResponseEvent(added(0, 'cmp_1'), state)).toEqual({
    type: 'context_compaction_started',
    provider: 'openai',
  });
});

// The defect this guards: durationMs used to be computed from a clock read taken after the
// stream had already finished, so it was structurally always ~0. Only the gap between the
// provider's own two frames is a real measurement.
it('measures the duration between the provider added and done frames', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
  const state = createResponseEventNormalizationState();

  normalizeResponseEvent(added(0, 'cmp_1'), state);
  vi.advanceTimersByTime(1376);

  expect(normalizeResponseEvent(done(0, 'cmp_1'), state)).toEqual({
    type: 'context_compaction_completed',
    provider: 'openai',
    durationMs: 1376,
  });
});

it('pairs each compaction item separately across the [compaction, message, compaction] order', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
  const state = createResponseEventNormalizationState();

  // Leading compaction: fast.
  normalizeResponseEvent(added(0, 'cmp_1'), state);
  vi.advanceTimersByTime(16);
  const leading = normalizeResponseEvent(done(0, 'cmp_1'), state);

  // The message in between must not disturb the pairing.
  normalizeResponseEvent(
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
    state,
  );
  vi.advanceTimersByTime(240);

  // Trailing compaction: slow, and this is the one that becomes history.
  normalizeResponseEvent(added(2, 'cmp_2'), state);
  vi.advanceTimersByTime(1376);
  const trailing = normalizeResponseEvent(done(2, 'cmp_2'), state);

  expect(leading).toMatchObject({ type: 'context_compaction_completed', durationMs: 16 });
  expect(trailing).toMatchObject({ type: 'context_compaction_completed', durationMs: 1376 });
});

it('reports 0 rather than inventing an interval for an unpaired done frame', () => {
  const state = createResponseEventNormalizationState();
  expect(normalizeResponseEvent(done(0, 'cmp_orphan'), state)).toEqual({
    type: 'context_compaction_completed',
    provider: 'openai',
    durationMs: 0,
  });
});

it('leaves non-compaction output items alone', () => {
  const state = createResponseEventNormalizationState();
  expect(
    normalizeResponseEvent(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      state,
    ),
  ).toBeNull();
  expect(
    normalizeResponseEvent(
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      state,
    ),
  ).toBeNull();
});
