import { it, expect } from 'vitest';
import {
  filterChainedModelInput,
  findChainedDeltaStart,
  getToolCallId,
  getToolResultCallId,
  isMissingChainedToolOutputError,
  isOrphanedChainedToolOutputError,
  isToolResultItem,
  isUserInputMessage,
  OrphanedChainedToolOutputError,
  asRecord,
} from './chained-input-filter.js';

// --- asRecord ---

it('asRecord returns object for plain objects', () => {
  expect(asRecord({ a: 1 })).toEqual({ a: 1 });
});

it('asRecord returns null for arrays', () => {
  expect(asRecord([1, 2])).toBe(null);
});

it('asRecord returns null for primitives', () => {
  expect(asRecord('hello')).toBe(null);
  expect(asRecord(42)).toBe(null);
  expect(asRecord(null)).toBe(null);
});

// --- isUserInputMessage ---

it('isUserInputMessage returns true for user role', () => {
  expect(isUserInputMessage({ role: 'user', content: 'hello' })).toBe(true);
});

it('isUserInputMessage returns false for assistant role', () => {
  expect(isUserInputMessage({ role: 'assistant' })).toBe(false);
});

it('isUserInputMessage returns false for non-objects', () => {
  expect(isUserInputMessage('string')).toBe(false);
  expect(isUserInputMessage(null)).toBe(false);
});

// --- isToolResultItem ---

it('isToolResultItem returns true for known tool result types', () => {
  for (const type of [
    'function_call_output',
    'function_call_result',
    'function_call_output_result',
    'tool_call_output',
    'tool_call_result',
    'tool_call_output_item',
    'local_shell_call_output',
    'shell_call_output',
    'computer_call_output',
    'computer_call_result',
    'apply_patch_call_output',
  ]) {
    expect(isToolResultItem({ type })).toBe(true);
  }
});

it('isToolResultItem returns false for unknown types', () => {
  expect(isToolResultItem({ type: 'message' })).toBe(false);
  expect(isToolResultItem({ type: 'text' })).toBe(false);
});

it('isToolResultItem returns false for non-objects', () => {
  expect(isToolResultItem(null)).toBe(false);
  expect(isToolResultItem('string')).toBe(false);
});

// --- getToolResultCallId ---

it('getToolResultCallId extracts callId from tool result item', () => {
  const item = { type: 'function_call_output', callId: 'call_123', output: 'ok' };
  expect(getToolResultCallId(item)).toBe('call_123');
});

it('getToolResultCallId extracts call_id as fallback', () => {
  const item = { type: 'function_call_output', call_id: 'call_456', output: 'ok' };
  expect(getToolResultCallId(item)).toBe('call_456');
});

it('getToolResultCallId extracts tool_call_id as fallback', () => {
  const item = { type: 'tool_call_output', tool_call_id: 'call_789', output: 'ok' };
  expect(getToolResultCallId(item)).toBe('call_789');
});

it('getToolResultCallId extracts from rawItem when top-level has no callId', () => {
  const item = { type: 'function_call_output', rawItem: { callId: 'raw_001' } };
  expect(getToolResultCallId(item)).toBe('raw_001');
});

it('getToolResultCallId falls back to top-level call_id when rawItem lacks call ID', () => {
  const item = { type: 'function_call_output', call_id: 'top_001', output: 'ok', rawItem: { output: 'ok' } };
  expect(getToolResultCallId(item)).toBe('top_001');
});

it('getToolResultCallId preserves top-level ID precedence over a wrapped provider ID', () => {
  const item = {
    type: 'function_call_output',
    callId: 'top_001',
    rawItem: { type: 'function_call_output', callId: 'raw_001', output: 'ok' },
  };
  expect(getToolResultCallId(item)).toBe('top_001');
});

it('getToolResultCallId returns null for non-tool-result items', () => {
  expect(getToolResultCallId({ role: 'user', content: 'hi' })).toBe(null);
});

it('getToolResultCallId returns null when callId is missing', () => {
  expect(getToolResultCallId({ type: 'function_call_output', output: 'ok' })).toBe(null);
});

it('getToolCallId does not treat a provider item id as tool-call correlation', () => {
  expect(getToolCallId({ type: 'image_generation_call', id: 'ig_1', status: 'completed' })).toBe(null);
});

// --- findChainedDeltaStart ---

it('findChainedDeltaStart returns index of first trailing tool result', () => {
  const input = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c2', output: 'r2' },
  ];
  expect(findChainedDeltaStart(input)).toBe(2);
});

it('findChainedDeltaStart returns last user message index when no trailing tool results', () => {
  const input = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'reply2' },
  ];
  expect(findChainedDeltaStart(input)).toBe(2);
});

it('findChainedDeltaStart returns 0 when input has no user messages or tool results', () => {
  const input = [{ role: 'assistant', content: 'only' }];
  expect(findChainedDeltaStart(input)).toBe(0);
});

it('findChainedDeltaStart returns 0 for empty input', () => {
  expect(findChainedDeltaStart([])).toBe(0);
});

// --- filterChainedModelInput ---

it('filterChainedModelInput returns modelData unchanged when input is not an array', () => {
  const modelData = { input: null, other: 'data' };
  expect(filterChainedModelInput(modelData)).toEqual(modelData);
});

it('filterChainedModelInput returns modelData unchanged when input has 0 or 1 items', () => {
  const modelData = { input: [{ role: 'user', content: 'hi' }] };
  expect(filterChainedModelInput(modelData)).toEqual(modelData);
  expect(filterChainedModelInput({ input: [] })).toEqual({ input: [] });
});

it('filterChainedModelInput keeps only specified toolResultCallIds when provided', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
      { type: 'function_call_output', callId: 'c3', output: 'r3' },
    ],
  };
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c3'] });
  expect(result.input).toEqual([
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c3', output: 'r3' },
  ]);
});

it('filterChainedModelInput keeps outputs whose top-level call_id is recoverable even when rawItem lacks it', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', call_id: 'c2', output: 'r2', rawItem: { output: 'r2' } },
      { type: 'function_call_output', callId: 'c3', output: 'r3' },
    ],
  };
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c2', 'c3'] });
  expect(result.input).toEqual([
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', call_id: 'c2', output: 'r2', rawItem: { output: 'r2' } },
    { type: 'function_call_output', callId: 'c3', output: 'r3' },
  ]);
});

it('filterChainedModelInput falls back to delta start when no matching callIds found', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
    ],
  };
  // No matching callIds → falls back to findChainedDeltaStart → trailing tool result start at index 2
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['nonexistent'] });
  expect(result.input).toEqual([{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

it('filterChainedModelInput preserves non-input properties on modelData', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
    ],
    metadata: { key: 'value' },
  };
  const result = filterChainedModelInput(modelData);
  expect(result.metadata).toBe(modelData.metadata);
});

it('filterChainedModelInput handles toolResultCallIds with falsy entries', () => {
  const modelData = {
    input: [
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };
  // Falsy entries (empty string) should be filtered out from toolResultCallIds
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', '', undefined as any] });
  expect(result.input).toEqual([{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

it('filterChainedModelInput rejects an empty chained delta when tool outputs are required', () => {
  let thrown: unknown;

  try {
    filterChainedModelInput({ input: [] }, { toolResultCallIds: ['call-required'] });
  } catch (error) {
    thrown = error;
  }

  expect(isMissingChainedToolOutputError(thrown)).toBe(true);
});

it('filterChainedModelInput returns full input when deltaStart is 0', () => {
  const modelData = {
    input: [
      { role: 'assistant', content: 'only' },
      { role: 'assistant', content: 'assistant2' },
    ],
  };
  const result = filterChainedModelInput(modelData);
  expect(result.input).toEqual(modelData.input);
});

// --- getToolCallId ---

it('getToolCallId extracts callId from a function_call item', () => {
  expect(getToolCallId({ type: 'function_call', callId: 'call_1', name: 'grep' })).toBe('call_1');
});

it('getToolCallId extracts call_id from a hosted call item', () => {
  expect(getToolCallId({ type: 'local_shell_call', call_id: 'call_2' })).toBe('call_2');
});

it('getToolCallId extracts callId from rawItem', () => {
  expect(getToolCallId({ type: 'function_call', rawItem: { callId: 'call_3' } })).toBe('call_3');
});

it('getToolCallId returns null for tool result items', () => {
  expect(getToolCallId({ type: 'function_call_output', callId: 'call_4', output: 'ok' })).toBe(null);
});

it('getToolCallId returns null for non-call items', () => {
  expect(getToolCallId({ role: 'user', content: 'hi' })).toBe(null);
  expect(getToolCallId({ type: 'reasoning', content: [] })).toBe(null);
  expect(getToolCallId(null)).toBe(null);
});

it.each([
  {
    label: 'direct provider items',
    call: { type: 'local_shell_call', call_id: 'call-representation', name: 'shell', arguments: '{}' },
    result: { type: 'local_shell_call_output', tool_call_id: 'call-representation', output: 'ok' },
  },
  {
    label: 'one-level wrapped provider items',
    call: { rawItem: { type: 'local_shell_call', call_id: 'call-representation', name: 'shell', arguments: '{}' } },
    result: { rawItem: { type: 'local_shell_call_output', tool_call_id: 'call-representation' }, output: 'ok' },
  },
  {
    label: 'canonical items',
    call: { type: 'tool_call', callId: 'call-representation', toolName: 'shell', arguments: '{}' },
    result: {
      type: 'tool_result',
      callId: 'call-representation',
      toolName: 'shell',
      status: 'completed',
      output: 'ok',
    },
  },
])('filters and pairs $label without replacing provider objects', ({ call, result }) => {
  const input = [{ role: 'user', content: 'hi' }, call, result];

  expect(getToolCallId(call)).toBe('call-representation');
  expect(isToolResultItem(result)).toBe(true);
  expect(getToolResultCallId(result)).toBe('call-representation');

  const filtered = filterChainedModelInput(
    { input },
    { toolResultCallIds: ['call-representation'], knownToolCallIds: ['another-call'] },
  );

  expect(filtered.input).toHaveLength(1);
  expect(filtered.input[0]).toBe(result);
});

// --- orphaned tool outputs (chain rebuilt without the matching calls) ---

// Regression: after a transport failure the turn was replayed statelessly and
// the replayed history no longer carried the `function_call` items for two
// already-executed tools. The next chained request selected only those tool
// outputs, so the provider rejected it with
// "No tool call found for function call output with call_id ...".
it('filterChainedModelInput rejects an expected tool output whose function_call is missing from the input', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', callId: 'c1', name: 'grep', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      // c2's function_call was dropped when the chain root was rebuilt.
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };

  let thrown: unknown;
  try {
    filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c2'] });
  } catch (error) {
    thrown = error;
  }

  expect(isOrphanedChainedToolOutputError(thrown)).toBe(true);
  expect((thrown as OrphanedChainedToolOutputError).callIds).toEqual(['c2']);
});

it('filterChainedModelInput reports every orphaned call id once', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', callId: 'kept', name: 'grep', arguments: '{}' },
      { type: 'function_call_output', callId: 'kept', output: 'r0' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };

  let thrown: unknown;
  try {
    filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c2'] });
  } catch (error) {
    thrown = error;
  }

  expect((thrown as OrphanedChainedToolOutputError).callIds).toEqual(['c1', 'c2']);
});

it('filterChainedModelInput accepts expected tool outputs whose function_call is present in the input', () => {
  const modelData = {
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', callId: 'c1', name: 'grep', arguments: '{}' },
      { type: 'function_call', callId: 'c2', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };

  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1', 'c2'] });

  expect(result.input).toEqual([
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c2', output: 'r2' },
  ]);
});

it('filterChainedModelInput skips the orphan check when the input carries no tool calls', () => {
  // A pre-trimmed delta holds only the outputs; the matching calls live in the
  // chain the provider already has, so absence proves nothing here.
  const modelData = {
    input: [{ type: 'function_call_output', callId: 'c1', output: 'r1' }],
  };

  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['c1'] });

  expect(result.input).toEqual([{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

// Regression: a pre-trimmed delta carrying an output whose function_call the
// chain anchor never recorded is a guaranteed provider 400 ("No tool call found
// for function call output with call_id ..."). The input alone cannot reveal
// this, so the caller supplies the call ids the anchor is known to hold.
it('filterChainedModelInput rejects a pre-trimmed delta whose call is absent from the known call ids', () => {
  const modelData = {
    input: [{ type: 'function_call_output', callId: 'orphan', output: 'r1' }],
  };

  let thrown: unknown;
  try {
    filterChainedModelInput(modelData, {
      toolResultCallIds: ['orphan'],
      knownToolCallIds: ['other'],
    });
  } catch (error) {
    thrown = error;
  }

  expect(isOrphanedChainedToolOutputError(thrown)).toBe(true);
  expect((thrown as OrphanedChainedToolOutputError).callIds).toEqual(['orphan']);
});

it('filterChainedModelInput accepts a pre-trimmed delta whose call is among the known call ids', () => {
  const modelData = {
    input: [{ type: 'function_call_output', callId: 'c1', output: 'r1' }],
  };

  const result = filterChainedModelInput(modelData, {
    toolResultCallIds: ['c1'],
    knownToolCallIds: ['c1'],
  });

  expect(result.input).toEqual([{ type: 'function_call_output', callId: 'c1', output: 'r1' }]);
});

it('filterChainedModelInput accepts an output whose call is known only to the anchor, not the input', () => {
  const modelData = {
    input: [
      { type: 'function_call', callId: 'c2', name: 'grep', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'r1' },
      { type: 'function_call_output', callId: 'c2', output: 'r2' },
    ],
  };

  const result = filterChainedModelInput(modelData, {
    toolResultCallIds: ['c1', 'c2'],
    knownToolCallIds: ['c1'],
  });

  expect(result.input).toEqual([
    { type: 'function_call_output', callId: 'c1', output: 'r1' },
    { type: 'function_call_output', callId: 'c2', output: 'r2' },
  ]);
});

// Delta-mode safety (concern 4): toolResultCallIds may include call IDs from
// prior continuation cycles (a superset from the cumulative ledger). Call IDs
// that have no matching item in the current modelData.input are silently
// ignored — no duplication, no error. Re-sent outputs are idempotent for
// providers using previousResponseId.
it('filterChainedModelInput ignores toolResultCallIds without a matching item in input (multi-cycle superset)', () => {
  const modelData = {
    input: [
      // Only cycle-2's output is present; cycle-1's output was already sent
      // in a prior cycle and is not replayed by the SDK.
      { type: 'function_call_output', callId: 'call-B', output: 'result-B' },
    ],
  };
  // toolResultCallIds includes call-A (prior cycle) and call-B (current).
  const result = filterChainedModelInput(modelData, { toolResultCallIds: ['call-A', 'call-B'] });
  // call-A has no matching item in input, so it is silently ignored — no
  // duplication and no synthetic item is fabricated.
  expect(result.input).toEqual([{ type: 'function_call_output', callId: 'call-B', output: 'result-B' }]);
});
