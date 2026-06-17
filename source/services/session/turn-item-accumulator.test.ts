import { it, expect } from 'vitest';
import { TurnItemAccumulator } from './turn-item-accumulator.js';

it('flushReasoningItem flushes non-empty buffer and is a no-op when empty', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.flushReasoningItem();
  expect(accumulator.getTurnItems()).toEqual([]);

  accumulator.appendReasoningDelta('thinking');
  accumulator.flushReasoningItem();

  expect(accumulator.getTurnItems()).toEqual([{ type: 'reasoning', text: 'thinking' }]);
});

it('flushAssistantTextItem flushes non-empty buffer and is a no-op when empty', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.flushAssistantTextItem();
  expect(accumulator.getTurnItems()).toEqual([]);

  accumulator.appendTextDelta('hello');
  accumulator.flushAssistantTextItem();

  expect(accumulator.getTurnItems()).toEqual([{ type: 'assistant_text', text: 'hello' }]);
});

it('recordToolCallItem flushes both buffers before recording the tool call', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.recordToolCallItem('call-1', 'search', { query: 'term2' });

  expect(accumulator.getTurnItems()).toEqual([
    { type: 'reasoning', text: 'reason' },
    { type: 'assistant_text', text: 'text' },
    { type: 'tool_call', callId: 'call-1', toolName: 'search', arguments: { query: 'term2' } },
  ]);
});

it('recordToolResultItem flushes both buffers before recording the tool result', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.recordToolResultItem('call-1', 'search', 'completed', { answer: 'done' });

  expect(accumulator.getTurnItems()).toEqual([
    { type: 'reasoning', text: 'reason' },
    { type: 'assistant_text', text: 'text' },
    { type: 'tool_result', callId: 'call-1', toolName: 'search', status: 'completed', output: { answer: 'done' } },
  ]);
});

it('resetPersistedTurnState clears all state', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.setDisplayUsage({ prompt_tokens: 1 });
  accumulator.recordToolCallItem('call-1', 'search', {});

  accumulator.resetPersistedTurnState();

  expect(accumulator.getTurnItems()).toEqual([]);
  expect(accumulator.getDisplayUsage()).toBe(undefined);
  expect(accumulator.hasReasoningBuffer()).toBe(false);
  expect(accumulator.hasTextBuffer()).toBe(false);
});

it('appendTextDelta and appendReasoningDelta accumulate deltas', () => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendTextDelta('hel');
  accumulator.appendTextDelta('lo');
  accumulator.appendReasoningDelta('th');
  accumulator.appendReasoningDelta('ink');

  expect(accumulator.hasTextBuffer()).toBe(true);
  expect(accumulator.hasReasoningBuffer()).toBe(true);

  accumulator.flushAssistantTextItem();
  accumulator.flushReasoningItem();

  expect(accumulator.getTurnItems()).toEqual([
    { type: 'assistant_text', text: 'hello' },
    { type: 'reasoning', text: 'think' },
  ]);
});

it('getDisplayUsage and setDisplayUsage track display usage', () => {
  const accumulator = new TurnItemAccumulator();
  const usage = { prompt_tokens: 12, completion_tokens: 34 };

  expect(accumulator.getDisplayUsage()).toBe(undefined);

  accumulator.setDisplayUsage(usage);

  expect(accumulator.getDisplayUsage()).toEqual(usage);
});
