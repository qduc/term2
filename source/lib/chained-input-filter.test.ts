import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
  for (const type of TOOL_RESULT_ITEM_TYPES) {
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

it('getToolResultCallId returns null for non-tool-result items', () => {
  expect(getToolResultCallId({ role: 'user', content: 'hi' })).toBe(null);
});

it('getToolResultCallId returns null when callId is missing', () => {
  expect(getToolResultCallId({ type: 'function_call_output', output: 'ok' })).toBe(null);
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
