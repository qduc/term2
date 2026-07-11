import { expect, it } from 'vitest';
import type { ChainedWireProtocol } from './chained-wire-state.js';
import { ChainedWireState } from './chained-wire-state.js';
import deepEqual from 'fast-deep-equal';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type RecordValue = Record<string, unknown>;

/**
 * Creates a minimal protocol implementation for testing.
 * The caller can override any method to control behavior per test.
 */
function makeProtocol(overrides: Partial<ChainedWireProtocol> = {}): ChainedWireProtocol {
  return {
    getInput(requestData: RecordValue): unknown[] {
      return Array.isArray(requestData.input) ? requestData.input : [];
    },
    getPreviousResponseId(requestData: RecordValue): string | undefined {
      return typeof requestData.previous_response_id === 'string' && requestData.previous_response_id.length > 0
        ? requestData.previous_response_id
        : undefined;
    },
    getFingerprint(requestData: RecordValue, _input: unknown[]): string {
      // Mirror the real getComparableRequest: exclude input and
      // previous_response_id so the fingerprint stays stable across
      // conversation turns as long as the request configuration
      // (model, tools, etc.) stays the same.
      const { input: _in, previous_response_id: _prev, ...rest } = requestData;
      return JSON.stringify(rest);
    },
    getPrefix(input: unknown[]): unknown[] {
      return input.slice(0, 0);
    },
    normalizeOutputItems(items: unknown[]): unknown[] {
      return items;
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exact baseline delta
// ---------------------------------------------------------------------------

it('computes exact baseline delta when stored input+output matches new input start', () => {
  const prefix = [{ type: 'additional_tools', role: 'developer', tools: [] }];
  const openingUser = { role: 'user', content: 'hello' };
  const assistantResponse = { type: 'message', role: 'assistant', content: 'hi' };
  const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: 'done' };

  const protocol = makeProtocol({
    getPrefix: (input) => {
      // Return the first item as the prefix
      return input.slice(0, 1);
    },
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // First turn: no stored state, so full request is sent.
  const first = state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input: [...prefix, openingUser],
  });
  expect(first.usedDelta).toBe(false);
  expect(first.token).toBe('token-1');

  // Record the response.
  state.recordResponse(key, 'token-1', 'resp-1', [assistantResponse]);

  // Second turn: previous_response_id matches, fingerprint matches,
  // input is [prefix, openingUser, assistantResponse, toolOutput].
  // Baseline is [prefix, openingUser, assistantResponse] so delta is [toolOutput].
  const second = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [...prefix, openingUser, assistantResponse, toolOutput],
  });
  expect(second.usedDelta).toBe(true);
  expect(second.requestData.input).toEqual([toolOutput]);
  expect(second.token).toBe('token-2');
});

// ---------------------------------------------------------------------------
// Stale continuity full fallback
// ---------------------------------------------------------------------------

it('returns full request when previous_response_id does not match stored responseId', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const fullInput = [{ role: 'user', content: 'hello' }];

  // Establish stored state with resp-1.
  state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input: fullInput,
  });
  state.recordResponse(key, 'token-1', 'resp-1', []);

  // Now request with a different previous_response_id → stale continuity.
  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-2', // does NOT match stored resp-1
    input: fullInput,
  });

  expect(prepared.usedDelta).toBe(false);
  expect(prepared.requestData.input).toEqual(fullInput);
});

it('returns full request when there is no stored state at all', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const fullInput = [{ role: 'user', content: 'hello' }];

  const prepared = state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: fullInput,
  });

  expect(prepared.usedDelta).toBe(false);
  expect(prepared.requestData.input).toEqual(fullInput);
});

it('returns full request when no previous_response_id is provided', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const fullInput = [{ role: 'user', content: 'hello' }];

  // Establish stored state.
  state.prepare(key, 'token-1', { model: 'gpt-5.6-luna', input: fullInput });
  state.recordResponse(key, 'token-1', 'resp-1', []);

  // No previous_response_id → should not attempt delta.
  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    input: fullInput,
  });

  expect(prepared.usedDelta).toBe(false);
  expect(prepared.requestData.input).toEqual(fullInput);
});

// ---------------------------------------------------------------------------
// Changed fingerprint full fallback
// ---------------------------------------------------------------------------

it('returns full request when fingerprint has changed', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const input = [{ role: 'user', content: 'hello' }];

  // Establish stored state with model A.
  state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input,
  });
  state.recordResponse(key, 'token-1', 'resp-1', []);

  // Now request with a different model → different fingerprint.
  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna-v2',
    previous_response_id: 'resp-1',
    input,
  });

  expect(prepared.usedDelta).toBe(false);
  expect(prepared.requestData.input).toEqual(input);
  // The fingerprint should differ because the model is different.
});

// ---------------------------------------------------------------------------
// Explicit reusable-prefix fallback
// ---------------------------------------------------------------------------

it('falls back to prefix-based delta when baseline does not match but prefix does', () => {
  const prefix = [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'shell' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] },
  ];
  const openingUser = { role: 'user', content: 'hello' };
  const assistantResponse = { type: 'message', role: 'assistant', content: 'hi' };
  const newUserMessage = { role: 'user', content: 'continue' };

  const protocol = makeProtocol({
    getPrefix: (input) => {
      // First two items are the prefix.
      return input.slice(0, 2);
    },
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // First turn.
  state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input: [...prefix, openingUser],
  });
  state.recordResponse(key, 'token-1', 'resp-1', [assistantResponse]);

  // Second turn: input is [prefix, newUserMessage].
  // Baseline is [prefix, openingUser, assistantResponse].
  // Baseline does NOT match (newUserMessage != openingUser), but prefix matches.
  // Delta should be input.slice(prefix.length) = [newUserMessage].
  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [...prefix, newUserMessage],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([newUserMessage]);
});

it('falls back to full input as delta when prefix is empty and baseline does not match', () => {
  const prefixItem = { type: 'additional_tools', role: 'developer', tools: [] };
  const openingUser = { role: 'user', content: 'hello' };
  const assistantResponse = { type: 'message', role: 'assistant', content: 'hi' };

  // A protocol whose prefix is conditional, like the real Luna protocol:
  // it only returns a non-empty prefix when the input starts with
  // additional_tools items.
  const protocol = makeProtocol({
    getPrefix: (input) => {
      if (input.length > 0 && (input[0] as RecordValue)?.type === 'additional_tools') {
        return [input[0]];
      }
      return [];
    },
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // Establish stored state: baseline = [prefixItem, openingUser, assistantResponse]
  state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input: [prefixItem, openingUser],
  });
  state.recordResponse(key, 'token-1', 'resp-1', [assistantResponse]);

  // New input that starts with a different first item — the prefix will be
  // empty (because the first item is not additional_tools). The baseline
  // doesn't match either. Since the prefix is empty, the fallback produces
  // the full input as the delta (usedDelta=true).
  const completelyDifferentInput = [{ type: 'message', role: 'user', content: 'unrelated' }];
  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: completelyDifferentInput,
  });

  // Empty prefix matches everything, so the full input becomes the delta.
  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual(completelyDifferentInput);
});

// ---------------------------------------------------------------------------
// Request-token correlation including out-of-order acknowledgements
// ---------------------------------------------------------------------------

it('correlates requests and responses by token when acknowledgements arrive out of order', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const inputA = [{ role: 'user', content: 'request A' }];
  const inputB = [{ role: 'user', content: 'request B' }];
  const outputA = [{ type: 'output', content: 'A response' }];
  const outputB = [{ type: 'output', content: 'B response' }];

  // Prepare two requests before any response is recorded.
  const prepA = state.prepare(key, 'token-A', {
    model: 'gpt-5.6-luna',
    input: inputA,
  });
  const prepB = state.prepare(key, 'token-B', {
    model: 'gpt-5.6-luna',
    input: inputB,
  });

  expect(prepA.usedDelta).toBe(false);
  expect(prepB.usedDelta).toBe(false);

  // Response for token-B (newer prepared) arrives first.
  state.recordResponse(key, 'token-B', 'resp-B', outputB);

  // Response for token-A (older prepared) arrives later out of order.
  // With monotonic sequencing, the older request must not overwrite the
  // newer baseline established by token-B.
  state.recordResponse(key, 'token-A', 'resp-A', outputA);

  // Stored state should still reflect token-B, not token-A.
  // Verify by chaining off resp-B.
  const next = state.prepare(key, 'token-C', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-B',
    input: [...inputB, ...outputB, { role: 'user', content: 'next' }],
  });

  expect(next.usedDelta).toBe(true);
  expect(next.requestData.input).toEqual([{ role: 'user', content: 'next' }]);

  // Chaining off the older resp-A should NOT work.
  const stale = state.prepare(key, 'token-D', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-A',
    input: [...inputA, ...outputA, { role: 'user', content: 'stale' }],
  });

  expect(stale.usedDelta).toBe(false);
  expect(stale.requestData.input).toEqual([...inputA, ...outputA, { role: 'user', content: 'stale' }]);
});

it('silently ignores recordResponse for an unknown token', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // Record response for a token that was never prepared → should not throw.
  expect(() => {
    state.recordResponse(key, 'unknown-token', 'resp-1', []);
  }).not.toThrow();

  // No stored state should exist.
  const prepared = state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [{ role: 'user', content: 'hello' }],
  });
  expect(prepared.usedDelta).toBe(false);
});

it('abandons only the specified pending request', () => {
  const state = new ChainedWireState(makeProtocol());

  state.prepare('session-1', 'abandoned', {
    model: 'm',
    input: [{ role: 'user', content: 'abandoned' }],
  });
  state.prepare('session-1', 'completed', {
    model: 'm',
    input: [{ role: 'user', content: 'completed' }],
  });

  state.abandon('session-1', 'abandoned');
  state.recordResponse('session-1', 'abandoned', 'resp-abandoned', []);
  state.recordResponse('session-1', 'completed', 'resp-completed', []);

  const completedChain = state.prepare('session-1', 'next', {
    model: 'm',
    previous_response_id: 'resp-completed',
    input: [{ role: 'user', content: 'completed' }],
  });
  expect(completedChain.usedDelta).toBe(true);

  const abandonedChain = state.prepare('session-1', 'stale', {
    model: 'm',
    previous_response_id: 'resp-abandoned',
    input: [{ role: 'user', content: 'abandoned' }],
  });
  expect(abandonedChain.usedDelta).toBe(false);
});

it('allows multiple concurrent pending requests under the same key', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // Prepare three concurrent requests.
  state.prepare(key, 't1', { model: 'm', input: [{ role: 'user', content: 'A' }] });
  state.prepare(key, 't2', {
    model: 'm',
    input: [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
    ],
  });
  state.prepare(key, 't3', {
    model: 'm',
    input: [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
      { role: 'user', content: 'C' },
    ],
  });

  // Record responses in reverse order.
  state.recordResponse(key, 't3', 'resp-3', []);
  state.recordResponse(key, 't2', 'resp-2', []);
  state.recordResponse(key, 't1', 'resp-1', []);

  // With monotonic sequencing, the stored state reflects the newest prepared
  // request that was acknowledged: t3 (sequence 2 > 1 > 0).
  // t3's input was [{role:'user', content:'A'}, {role:'user', content:'B'}, {role:'user', content:'C'}].
  const prepared = state.prepare(key, 't4', {
    model: 'm',
    previous_response_id: 'resp-3',
    input: [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'user', content: 'next' },
    ],
  });
  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([{ role: 'user', content: 'next' }]);

  // Chaining off the older resp-1 should NOT work.
  const stale = state.prepare(key, 't5', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'stale' },
    ],
  });
  expect(stale.usedDelta).toBe(false);
});

it('preserves request data through the full lifecycle with interleaved tokens', () => {
  const prefixItem = { type: 'additional_tools', role: 'developer', tools: [] };
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 1),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const turn1 = { role: 'user', content: 'turn1' };
  const reply1 = { type: 'assistant', content: 'reply1' };
  const turn2 = { role: 'user', content: 'turn2' };
  const reply2 = { type: 'assistant', content: 'reply2' };
  const turn3 = { role: 'user', content: 'turn3' };
  const turn4 = { role: 'user', content: 'turn4' };

  // Turn 1: establish baseline.
  state.prepare(key, 't1', { model: 'm', input: [prefixItem, turn1] });
  state.recordResponse(key, 't1', 'resp-1', [reply1]);

  // Turn 2: chained delta. Full input includes the entire conversation so far.
  const t2 = state.prepare(key, 't2', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [prefixItem, turn1, reply1, turn2],
  });
  expect(t2.usedDelta).toBe(true);
  expect(t2.requestData.input).toEqual([turn2]);

  // Prepare turn 3 before turn 2's response arrives (concurrent).
  // Turn 3 also chains off resp-1 (the stored state hasn't changed).
  const t3 = state.prepare(key, 't3', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [prefixItem, turn1, reply1, turn3],
  });
  expect(t3.usedDelta).toBe(true);
  expect(t3.requestData.input).toEqual([turn3]);

  // Turn 3's response arrives first.
  state.recordResponse(key, 't3', 'resp-3', [{ type: 'assistant', content: 'reply3' }]);

  // Turn 2's response arrives second (out of order).
  // With monotonic sequencing, t2 (older prepared) must not overwrite
  // the newer baseline from t3.
  state.recordResponse(key, 't2', 'resp-2', [reply2]);

  // Stored state reflects t3 (the newest prepared that was acknowledged).
  // t3's full input was [prefixItem, turn1, reply1, turn3]
  // and its output was [reply3], so baseline is
  // [prefixItem, turn1, reply1, turn3, reply3].
  // Prepare turn 4 chained off resp-3.
  const t4 = state.prepare(key, 't4', {
    model: 'm',
    previous_response_id: 'resp-3',
    input: [prefixItem, turn1, reply1, turn3, { type: 'assistant', content: 'reply3' }, turn4],
  });
  expect(t4.usedDelta).toBe(true);
  expect(t4.requestData.input).toEqual([turn4]);

  // Chaining off the older resp-2 should NOT work.
  const stale = state.prepare(key, 't5', {
    model: 'm',
    previous_response_id: 'resp-2',
    input: [prefixItem, turn1, reply1, turn2, reply2, turn4],
  });
  expect(stale.usedDelta).toBe(false);
});

// ---------------------------------------------------------------------------
// Invalidate and clear
// ---------------------------------------------------------------------------

it('invalidate removes stored and pending state for a key', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const fullInput = [{ role: 'user', content: 'hello' }];

  // Establish state.
  state.prepare(key, 'token-1', { model: 'm', input: fullInput });
  state.recordResponse(key, 'token-1', 'resp-1', []);

  // Verify delta would work.
  const before = state.prepare(key, 'token-2', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: fullInput,
  });
  expect(before.usedDelta).toBe(true);

  // Invalidate.
  state.invalidate(key);

  // Now delta should not work.
  const after = state.prepare(key, 'token-3', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: fullInput,
  });
  expect(after.usedDelta).toBe(false);
});

it('invalidate also removes pending requests for the key', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  // Prepare without recording (pending only).
  state.prepare(key, 'token-1', { model: 'm', input: [{ role: 'user', content: 'hello' }] });

  // Invalidate.
  state.invalidate(key);

  // Recording should silently do nothing since pending was cleared.
  state.recordResponse(key, 'token-1', 'resp-1', []);

  // No stored state should exist.
  const prepared = state.prepare(key, 'token-2', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [{ role: 'user', content: 'hello' }],
  });
  expect(prepared.usedDelta).toBe(false);
});

it('invalidate is key-isolated', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });
  const state = new ChainedWireState(protocol);
  const inputA = [{ role: 'user', content: 'A' }];
  const inputB = [{ role: 'user', content: 'B' }];

  // Establish state for two keys.
  state.prepare('key-A', 't1', { model: 'm', input: inputA });
  state.recordResponse('key-A', 't1', 'resp-A', []);
  state.prepare('key-B', 't2', { model: 'm', input: inputB });
  state.recordResponse('key-B', 't2', 'resp-B', []);

  // Invalidate only key-A.
  state.invalidate('key-A');

  // key-A should be gone.
  const afterA = state.prepare('key-A', 't3', {
    model: 'm',
    previous_response_id: 'resp-A',
    input: inputA,
  });
  expect(afterA.usedDelta).toBe(false);

  // key-B should still work.
  const afterB = state.prepare('key-B', 't4', {
    model: 'm',
    previous_response_id: 'resp-B',
    input: inputB,
  });
  expect(afterB.usedDelta).toBe(true);
});

it('clear removes all state across all keys', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });
  const state = new ChainedWireState(protocol);
  const input1 = [{ role: 'user', content: 'A' }];
  const input2 = [{ role: 'user', content: 'B' }];

  // Establish state for two keys.
  state.prepare('key-1', 't1', { model: 'm', input: input1 });
  state.recordResponse('key-1', 't1', 'resp-1', []);
  state.prepare('key-2', 't2', { model: 'm', input: input2 });
  state.recordResponse('key-2', 't2', 'resp-2', []);

  // Also add a pending-only key.
  state.prepare('key-3', 't3', { model: 'm', input: [{ role: 'user', content: 'C' }] });

  // Clear everything.
  state.clear();

  // All keys should be gone.
  for (const key of ['key-1', 'key-2', 'key-3']) {
    const prepared = state.prepare(key, 't-clear', {
      model: 'm',
      previous_response_id: 'resp-1',
      input: input1,
    });
    expect(prepared.usedDelta).toBe(false);
  }
});

it('clear is idempotent', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);

  // Clear on empty state.
  expect(() => state.clear()).not.toThrow();

  // Clear twice.
  state.prepare('key-1', 't1', { model: 'm', input: [{ role: 'user', content: 'A' }] });
  state.clear();
  expect(() => state.clear()).not.toThrow();
});

// ---------------------------------------------------------------------------
// Protocol delegation
// ---------------------------------------------------------------------------

it('delegates normalizeOutputItems to the protocol when recording responses', () => {
  const normalized: unknown[][] = [];
  const protocol = makeProtocol({
    normalizeOutputItems(items: unknown[]): unknown[] {
      const result = items.map((item) => ({ ...(item as RecordValue), normalized: true }));
      normalized.push(result);
      return result;
    },
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  state.prepare(key, 'token-1', { model: 'm', input: [{ role: 'user', content: 'hello' }] });
  state.recordResponse(key, 'token-1', 'resp-1', [{ type: 'function_call', id: 'fc-1', call_id: 'call-1' }]);

  expect(normalized.length).toBe(1);
  expect(normalized[0]).toEqual([{ type: 'function_call', id: 'fc-1', call_id: 'call-1', normalized: true }]);
});

it('handles non-array output items gracefully', () => {
  const protocol = makeProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  state.prepare(key, 'token-1', { model: 'm', input: [{ role: 'user', content: 'hello' }] });

  // Pass a non-array as output items.
  expect(() => {
    state.recordResponse(key, 'token-1', 'resp-1', 'not-an-array' as unknown as unknown[]);
  }).not.toThrow();

  // The pending was consumed; verify we can't use it for delta.
  const prepared = state.prepare(key, 'token-2', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [{ role: 'user', content: 'hello' }],
  });
  // The stored outputItems is empty array, so baseline is just the input.
  // Delta should work (empty delta).
  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([]);
});

// ---------------------------------------------------------------------------
// Fingerprint isolation across keys
// ---------------------------------------------------------------------------

it('maintains separate fingerprint state for different keys', () => {
  const prefix1 = [{ type: 'additional_tools', role: 'developer', tools: [{ name: 'shell' }] }];
  const prefix2 = [{ type: 'additional_tools', role: 'developer', tools: [{ name: 'apply_patch' }] }];

  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 1),
  });

  const state = new ChainedWireState(protocol);

  // Key A with prefix1.
  state.prepare('key-A', 't1', { model: 'm', input: [...prefix1, { role: 'user', content: 'A1' }] });
  state.recordResponse('key-A', 't1', 'resp-A', [{ type: 'assistant', content: 'replyA' }]);

  // Key B with prefix2.
  state.prepare('key-B', 't2', { model: 'm', input: [...prefix2, { role: 'user', content: 'B1' }] });
  state.recordResponse('key-B', 't2', 'resp-B', [{ type: 'assistant', content: 'replyB' }]);

  // Key A should chain correctly.
  const aChain = state.prepare('key-A', 't3', {
    model: 'm',
    previous_response_id: 'resp-A',
    input: [
      ...prefix1,
      { role: 'user', content: 'A1' },
      { type: 'assistant', content: 'replyA' },
      { role: 'user', content: 'A2' },
    ],
  });
  expect(aChain.usedDelta).toBe(true);
  expect(aChain.requestData.input).toEqual([{ role: 'user', content: 'A2' }]);

  // Key B should chain correctly with its own fingerprint.
  const bChain = state.prepare('key-B', 't4', {
    model: 'm',
    previous_response_id: 'resp-B',
    input: [
      ...prefix2,
      { role: 'user', content: 'B1' },
      { type: 'assistant', content: 'replyB' },
      { role: 'user', content: 'B2' },
    ],
  });
  expect(bChain.usedDelta).toBe(true);
  expect(bChain.requestData.input).toEqual([{ role: 'user', content: 'B2' }]);

  // Cross-key previous_response_id should not work.
  const cross = state.prepare('key-A', 't5', {
    model: 'm',
    previous_response_id: 'resp-B',
    input: [...prefix1, { role: 'user', content: 'A1' }],
  });
  expect(cross.usedDelta).toBe(false);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

it('returns empty delta when input exactly equals the baseline', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const input = [{ role: 'user', content: 'hello' }];

  state.prepare(key, 'token-1', { model: 'm', input });
  state.recordResponse(key, 'token-1', 'resp-1', [{ type: 'assistant', content: 'reply' }]);

  // Input exactly matches baseline (input + output).
  const prepared = state.prepare(key, 'token-2', {
    model: 'm',
    previous_response_id: 'resp-1',
    input: [...input, { type: 'assistant', content: 'reply' }],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([]);
});

it('preserves other requestData fields when computing delta', () => {
  const protocol = makeProtocol({
    getPrefix: (input) => input.slice(0, 0),
  });

  const state = new ChainedWireState(protocol);
  const key = 'session-1';
  const model = 'm';

  // First prepare includes the same structural fields so the fingerprint
  // stays stable across turns.
  state.prepare(key, 'token-1', {
    model,
    input: [{ role: 'user', content: 'hello' }],
    instructions: 'do something',
    tools: [{ type: 'function', name: 'shell' }],
  });
  state.recordResponse(key, 'token-1', 'resp-1', [{ type: 'assistant', content: 'reply' }]);

  const prepared = state.prepare(key, 'token-2', {
    model,
    previous_response_id: 'resp-1',
    input: [
      { role: 'user', content: 'hello' },
      { type: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
    ],
    instructions: 'do something',
    tools: [{ type: 'function', name: 'shell' }],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([{ role: 'user', content: 'next' }]);
  expect(prepared.requestData.instructions).toBe('do something');
  expect(prepared.requestData.tools).toEqual([{ type: 'function', name: 'shell' }]);
});
