import test from 'ava';
import {
  filterChainedModelInput,
  findChainedDeltaStart,
  getToolResultCallId,
  isToolResultItem,
  isUserInputMessage,
  TOOL_RESULT_ITEM_TYPES,
  asRecord,
} from './chained-input-filter.js';

// --- asRecord ---

test('asRecord returns object for plain objects', (t) => {
  t.deepEqual(asRecord({ a: 1 }), { a: 1 });
});

test('asRecord returns null for arrays', (t) => {
  t.is(asRecord([1, 2]), null);
});

test('asRecord returns null for primitives', (t) => {
  t.is(asRecord('hello'), null);
  t.is(asRecord(42), null);
  t.is(asRecord(null), null);
});

// --- isUserInputMessage ---

test('isUserInputMessage returns true for user role', (t) => {
  t.true(isUserInputMessage({ role: 'user', content: 'hello' }));
});

test('isUserInputMessage returns false for assistant role', (t) => {
  t.false(isUserInputMessage({ role: 'assistant' }));
});

test('isUserInputMessage returns false for non-objects', (t) => {
  t.false(isUserInputMessage('string'));
  t.false(isUserInputMessage(null));
});

// --- isToolResultItem ---

test('isToolResultItem returns true for known tool result types', (t) => {
  for (const type of TOOL_RESULT_ITEM_TYPES) {
    t.true(isToolResultItem({ type }), `Expected true for type: ${type}`);
  }
});

test('isToolResultItem returns false for unknown types', (t) => {
  t.false(isToolResultItem({ type: 'message' }));
  t.false(isToolResultItem({ type: 'text' }));
});

test('isToolResultItem returns false for non-objects', (t) => {
  t.false(isToolResultItem(null));
  t.false(isToolResultItem('string'));
});

// --- getToolResultCallId ---

test('getToolResultCallId extracts callId from tool result item', (t) => {
  const item = { type: 'function_call_output', callId: 'call_123', output: 'ok' };
  t.is(getToolResultCallId(item), 'call_123');
});

test('getToolResultCallId extracts call_id as fallback', (t) => {
  const item = { type: 'function_call_output', call_id: 'call_456', output: 'ok' };
  t.is(getToolResultCallId(item), 'call_456');
});

test('getToolResultCallId extracts tool_call_id as fallback', (t) => {
  const item = { type: 'tool_call_output', tool_call_id: 'call_789', output: 'ok' };
  t.is(getToolResultCallId(item), 'call_789');
});

test('getToolResultCallId extracts from rawItem when top-level has no callId', (t) => {
  const item = { type: 'function_call_output', rawItem: { callId: 'raw_001' } };
  t.is(getToolResultCallId(item), 'raw_001');
});

test('getToolResultCallId returns null for non-tool-result items', (t) => {
  t.is(getToolResultCallId({ role: 'user', content: 'hi' }), null);
});

test('getToolResultCallId returns null when callId is missing', (t) => {
  t.is(getToolResultCallId({ type: 'function_call_output', output: 'ok' }), null);
});

// --- findChainedDeltaStart ---

test('findChainedDeltaStart returns index of first trailing tool result', (t) => {
  const input = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c2', output: 'r2' },
  ];
  t.is(findChainedDeltaStart(input), 2);
});

test('findChainedDeltaStart returns last user message index when no trailing tool results', (t) => {
  const input = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'reply2' },
  ];
  t.is(findChainedDeltaStart(input), 2);
});

test('findChainedDeltaStart returns 0 when input has no user messages or tool results', (t) => {
  const input = [{ role: 'assistant', content: 'only' }];
  t.is(findChainedDeltaStart(input), 0);
});

test('findChainedDeltaStart returns 0 for empty input', (t) => {
  t.is(findChainedDeltaStart([]), 0);
});

// --- filterChainedModelInput ---

test('filterChainedModelInput returns modelData unchanged when input is not an array', (t) => {
  const modelData = { input: null, other: 'data' };
  t.deepEqual(filterChainedModelInput(modelData), modelData);
});

test('filterChainedModelInput returns modelData unchanged when input has 0 or 1 items', (t) => {
  const modelData = { input: [{ role: 'user', content: 'hi' }] };
  t.deepEqual(filterChainedModelInput(modelData), modelData);
  t.deepEqual(filterChainedModelInput({ input: [] }), { input: [] });
});

test('filterChainedModelInput keeps only specified toolResultCallIds when provided', (t) => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
      { type: 'function_call_output', callId: 'c3', output: 'r3' },
    ],
  };
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c3'] });
  t.deepEqual(result.input, [
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c3', output: 'r3' },
  ]);
});

test('filterChainedModelInput falls back to delta start when no matching callIds found', (t) => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
    ],
  };
  // No matching callIds → falls back to findChainedDeltaStart → trailing tool result start at index 2
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['nonexistent'] });
  t.deepEqual(result.input, [{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

test('filterChainedModelInput preserves non-input properties on modelData', (t) => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
    ],
    metadata: { key: 'value' },
  };
  const result = filterChainedModelInput(modelData);
  t.is(result.metadata, modelData.metadata);
});

test('filterChainedModelInput handles toolResultCallIds with falsy entries', (t) => {
  const modelData = {
    input: [
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };
  // Falsy entries (empty string) should be filtered out from toolResultCallIds
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', '', undefined as any] });
  t.deepEqual(result.input, [{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

test('filterChainedModelInput returns full input when deltaStart is 0', (t) => {
  const modelData = {
    input: [
      { role: 'assistant', content: 'only' },
      { role: 'assistant', content: 'assistant2' },
    ],
  };
  const result = filterChainedModelInput(modelData);
  t.deepEqual(result.input, modelData.input);
});
