import { expect, it } from 'vitest';
import { normalizeLegacyAgentEvent, normalizeLegacySnapshotItems } from './legacy-agent-stream-adapter.js';

it('coerces array and object output text/content deltas', () => {
  expect(
    normalizeLegacyAgentEvent({
      type: 'response.output_text.delta',
      output_text: [{ text: 'hello ' }, { content: { value: 'world' } }],
    }),
  ).toEqual([{ type: 'text_delta', text: 'hello world' }]);
  expect(
    normalizeLegacyAgentEvent({
      type: 'output_text_delta',
      content: { text: 'object content' },
    }),
  ).toEqual([{ type: 'text_delta', text: 'object content' }]);
});

it('preserves usage co-located with direct delta events', () => {
  expect(
    normalizeLegacyAgentEvent({
      type: 'output_text_delta',
      delta: 'answer',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  ).toEqual([
    { type: 'usage_update', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    { type: 'text_delta', text: 'answer' },
  ]);
});

it('projects provider items out of legacy stream snapshots', () => {
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
  expect(
    normalizeLegacySnapshotItems([
      { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } },
      { type: 'run_item_stream_event', item: message },
      { type: 'text_delta', text: 'done' },
    ]),
  ).toEqual([message]);
});

it('uses response.output_item.added item as a fallback for tool names', () => {
  const state = {
    toolNames: new Map<number | string, string>(),
    toolArgumentChars: new Map<number | string, number>(),
  };
  expect(
    normalizeLegacyAgentEvent(
      {
        data: {
          event: {
            type: 'response.output_item.added',
            output_index: 2,
            item: { type: 'function_call', name: 'lookup' },
          },
        },
      },
      state,
    ),
  ).toEqual([]);
  expect(
    normalizeLegacyAgentEvent(
      {
        data: {
          event: {
            type: 'response.function_call_arguments.delta',
            output_index: 2,
            delta: '{"q":"x"}',
          },
        },
      },
      state,
    ),
  ).toEqual([{ type: 'tool_call_streaming_delta', toolName: 'lookup', argumentCharCount: 9 }]);
});

it('reads reasoning deltas from object-map choices', () => {
  expect(
    normalizeLegacyAgentEvent({
      data: {
        event: {
          choices: {
            '0': { delta: { reasoning_content: 'thinking' } },
          },
        },
      },
    }),
  ).toEqual([{ type: 'reasoning_delta', text: 'thinking' }]);
});

it('ignores empty and missing-index tool argument deltas', () => {
  const state = {
    toolNames: new Map<number | string, string>(),
    toolArgumentChars: new Map<number | string, number>(),
  };
  const events = [
    { type: 'response.function_call_arguments.delta', delta: 'x' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '' },
    { type: 'response.output_item.delta', delta: { arguments: 'x' } },
    { type: 'response.output_item.delta', output_index: 1, delta: { arguments: '' } },
    { type: 'tool-input-delta', id: 'call-1', delta: '' },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: 'x' } }] } }] },
  ];

  expect(events.flatMap((event) => normalizeLegacyAgentEvent(event, state))).toEqual([]);
});
