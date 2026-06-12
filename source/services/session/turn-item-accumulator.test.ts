import test from 'ava';
import { TurnItemAccumulator } from './turn-item-accumulator.js';

test('flushReasoningItem flushes non-empty buffer and is a no-op when empty', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.flushReasoningItem();
  t.deepEqual(accumulator.getTurnItems(), []);

  accumulator.appendReasoningDelta('thinking');
  accumulator.flushReasoningItem();

  t.deepEqual(accumulator.getTurnItems(), [{ type: 'reasoning', text: 'thinking' }]);
});

test('flushAssistantTextItem flushes non-empty buffer and is a no-op when empty', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.flushAssistantTextItem();
  t.deepEqual(accumulator.getTurnItems(), []);

  accumulator.appendTextDelta('hello');
  accumulator.flushAssistantTextItem();

  t.deepEqual(accumulator.getTurnItems(), [{ type: 'assistant_text', text: 'hello' }]);
});

test('recordToolCallItem flushes both buffers before recording the tool call', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.recordToolCallItem('call-1', 'search', { query: 'term2' });

  t.deepEqual(accumulator.getTurnItems(), [
    { type: 'reasoning', text: 'reason' },
    { type: 'assistant_text', text: 'text' },
    { type: 'tool_call', callId: 'call-1', toolName: 'search', arguments: { query: 'term2' } },
  ]);
});

test('recordToolResultItem flushes both buffers before recording the tool result', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.recordToolResultItem('call-1', 'search', 'completed', { answer: 'done' });

  t.deepEqual(accumulator.getTurnItems(), [
    { type: 'reasoning', text: 'reason' },
    { type: 'assistant_text', text: 'text' },
    { type: 'tool_result', callId: 'call-1', toolName: 'search', status: 'completed', output: { answer: 'done' } },
  ]);
});

test('resetPersistedTurnState clears all state', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendReasoningDelta('reason');
  accumulator.appendTextDelta('text');
  accumulator.setDisplayUsage({ prompt_tokens: 1 });
  accumulator.recordToolCallItem('call-1', 'search', {});

  accumulator.resetPersistedTurnState();

  t.deepEqual(accumulator.getTurnItems(), []);
  t.is(accumulator.getDisplayUsage(), undefined);
  t.false(accumulator.hasReasoningBuffer());
  t.false(accumulator.hasTextBuffer());
});

test('appendTextDelta and appendReasoningDelta accumulate deltas', (t) => {
  const accumulator = new TurnItemAccumulator();

  accumulator.appendTextDelta('hel');
  accumulator.appendTextDelta('lo');
  accumulator.appendReasoningDelta('th');
  accumulator.appendReasoningDelta('ink');

  t.true(accumulator.hasTextBuffer());
  t.true(accumulator.hasReasoningBuffer());

  accumulator.flushAssistantTextItem();
  accumulator.flushReasoningItem();

  t.deepEqual(accumulator.getTurnItems(), [
    { type: 'assistant_text', text: 'hello' },
    { type: 'reasoning', text: 'think' },
  ]);
});

test('getDisplayUsage and setDisplayUsage track display usage', (t) => {
  const accumulator = new TurnItemAccumulator();
  const usage = { prompt_tokens: 12, completion_tokens: 34 };

  t.is(accumulator.getDisplayUsage(), undefined);

  accumulator.setDisplayUsage(usage);

  t.deepEqual(accumulator.getDisplayUsage(), usage);
});
