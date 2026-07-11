import { expect, it } from 'vitest';
import { ChainedWireState } from './chained-wire-state.js';
import { LunaResponsesLiteWireProtocol } from './luna-responses-lite-wire-protocol.js';

// ---------------------------------------------------------------------------
// getInput
// ---------------------------------------------------------------------------

it('getInput returns the input array from requestData', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const input = [{ role: 'user', content: 'hello' }];
  expect(protocol.getInput({ model: 'gpt-5.6-luna', input })).toEqual(input);
});

it('getInput returns empty array when input is not an array', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getInput({ model: 'gpt-5.6-luna' })).toEqual([]);
  expect(protocol.getInput({ model: 'gpt-5.6-luna', input: 'not-an-array' })).toEqual([]);
  expect(protocol.getInput({ model: 'gpt-5.6-luna', input: null })).toEqual([]);
});

// ---------------------------------------------------------------------------
// getPreviousResponseId
// ---------------------------------------------------------------------------

it('getPreviousResponseId returns the previous_response_id when present and non-empty', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPreviousResponseId({ previous_response_id: 'resp-1' })).toBe('resp-1');
});

it('getPreviousResponseId returns undefined when previous_response_id is missing', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPreviousResponseId({ model: 'gpt-5.6-luna' })).toBeUndefined();
});

it('getPreviousResponseId returns undefined when previous_response_id is empty string', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPreviousResponseId({ previous_response_id: '' })).toBeUndefined();
});

it('getPreviousResponseId returns undefined when previous_response_id is not a string', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPreviousResponseId({ previous_response_id: 123 })).toBeUndefined();
  expect(protocol.getPreviousResponseId({ previous_response_id: null })).toBeUndefined();
});

// ---------------------------------------------------------------------------
// getFingerprint — excludes input, previous_response_id, client_metadata, generate
// ---------------------------------------------------------------------------

it('getFingerprint is stable when only input and previous_response_id change', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const fp1 = protocol.getFingerprint(
    { model: 'gpt-5.6-luna', tools: [], input: [{ role: 'user', content: 'hello' }] },
    [{ role: 'user', content: 'hello' }],
  );
  const fp2 = protocol.getFingerprint(
    {
      model: 'gpt-5.6-luna',
      tools: [],
      previous_response_id: 'resp-1',
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'call-1' },
      ],
    },
    [
      { role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call-1' },
    ],
  );
  expect(fp1).toBe(fp2);
});

it('getFingerprint changes when the model changes', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const input = [{ role: 'user', content: 'hello' }];
  const fp1 = protocol.getFingerprint({ model: 'gpt-5.6-luna', input }, input);
  const fp2 = protocol.getFingerprint({ model: 'gpt-5.6-luna-v2', input }, input);
  expect(fp1).not.toBe(fp2);
});

it('getFingerprint excludes client_metadata and generate from the fingerprint', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const input = [{ role: 'user', content: 'hello' }];
  const fp1 = protocol.getFingerprint(
    { model: 'gpt-5.6-luna', client_metadata: { key: 'a' }, generate: true, input },
    input,
  );
  const fp2 = protocol.getFingerprint(
    { model: 'gpt-5.6-luna', client_metadata: { key: 'b' }, generate: false, input },
    input,
  );
  expect(fp1).toBe(fp2);
});

it('getFingerprint includes the prefix from the input', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const prefixTools = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell' }],
  };
  const input1 = [prefixTools, { role: 'user', content: 'hello' }];

  const changedPrefixTools = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'apply_patch' }],
  };
  const input2 = [changedPrefixTools, { role: 'user', content: 'hello' }];

  const fp1 = protocol.getFingerprint({ model: 'gpt-5.6-luna' }, input1);
  const fp2 = protocol.getFingerprint({ model: 'gpt-5.6-luna' }, input2);
  // The prefix differs (different tools), so the fingerprint should differ.
  expect(fp1).not.toBe(fp2);
});

it('getFingerprint includes developer message in the prefix', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const prefixTools = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell' }],
  };
  const devMessage = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'You are helpful.' }],
  };
  const userMsg = { role: 'user', content: 'hello' };

  const fp1 = protocol.getFingerprint({ model: 'gpt-5.6-luna' }, [prefixTools, devMessage, userMsg]);

  const changedDevMessage = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'You are unhelpful.' }],
  };
  const fp2 = protocol.getFingerprint({ model: 'gpt-5.6-luna' }, [prefixTools, changedDevMessage, userMsg]);

  // The prefix differs (different developer instructions), so fingerprint differs.
  expect(fp1).not.toBe(fp2);
});

// ---------------------------------------------------------------------------
// getPrefix
// ---------------------------------------------------------------------------

it('getPrefix returns empty array when input is empty', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPrefix([])).toEqual([]);
});

it('getPrefix returns empty array when first item is not additional_tools', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  expect(protocol.getPrefix([{ role: 'user', content: 'hello' }])).toEqual([]);
});

it('getPrefix returns only the additional_tools item when present', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const toolsItem = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell' }],
  };
  const userMsg = { role: 'user', content: 'hello' };
  expect(protocol.getPrefix([toolsItem, userMsg])).toEqual([toolsItem]);
});

it('getPrefix includes a trailing developer message when it follows additional_tools', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const toolsItem = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell' }],
  };
  const devMessage = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'instructions' }],
  };
  const userMsg = { role: 'user', content: 'hello' };
  expect(protocol.getPrefix([toolsItem, devMessage, userMsg])).toEqual([toolsItem, devMessage]);
});

it('getPrefix does not include a non-developer message after additional_tools', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const toolsItem = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell' }],
  };
  const userMsg = { role: 'user', content: 'hello' };
  // Second item is a user message, not developer → not included in prefix.
  expect(protocol.getPrefix([toolsItem, userMsg])).toEqual([toolsItem]);
});

it('getPrefix does not include additional_tools with wrong role', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const notToolsItem = {
    type: 'additional_tools',
    role: 'user', // wrong role — must be 'developer'
    tools: [{ type: 'function', name: 'shell' }],
  };
  expect(protocol.getPrefix([notToolsItem])).toEqual([]);
});

// ---------------------------------------------------------------------------
// normalizeOutputItems
// ---------------------------------------------------------------------------

it('normalizeOutputItems strips id from relevant item types', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = [
    { id: 'msg-1', type: 'message', role: 'assistant', content: 'hi' },
    { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' },
    { id: 'ls-1', type: 'local_shell_call', command: 'ls' },
    { id: 'ts-1', type: 'tool_search_call', query: 'test' },
    { id: 'ct-1', type: 'custom_tool_call', name: 'custom' },
    { id: 'ws-1', type: 'web_search_call', query: 'search' },
  ];

  const normalized = protocol.normalizeOutputItems(items);
  expect(normalized).toEqual([
    { type: 'message', role: 'assistant', content: 'hi' },
    { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' },
    { type: 'local_shell_call', command: 'ls' },
    { type: 'tool_search_call', query: 'test' },
    { type: 'custom_tool_call', name: 'custom' },
    { type: 'web_search_call', query: 'search' },
  ]);
});

it('normalizeOutputItems preserves items whose type is not in the stripping set', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = [
    { id: 'fco-1', type: 'function_call_output', call_id: 'call-1', output: 'done' },
    { id: 'unknown-1', type: 'unknown_type', data: 'x' },
  ];

  const normalized = protocol.normalizeOutputItems(items);
  expect(normalized).toEqual(items);
});

it('normalizeOutputItems handles items without id', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = [
    { type: 'message', role: 'assistant', content: 'hi' }, // no id
    { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' }, // no id
  ];

  const normalized = protocol.normalizeOutputItems(items);
  expect(normalized).toEqual(items);
});

it('normalizeOutputItems handles non-record items gracefully', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = ['string-item', 42, null, undefined];
  const normalized = protocol.normalizeOutputItems(items as unknown[]);
  expect(normalized).toEqual(items);
});

it('normalizeOutputItems handles items with no type field', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = [{ id: 'x-1', name: 'no-type' }];
  const normalized = protocol.normalizeOutputItems(items);
  expect(normalized).toEqual(items);
});

it('normalizeOutputItems returns a new array (does not mutate input)', () => {
  const protocol = new LunaResponsesLiteWireProtocol();
  const items = [{ id: 'msg-1', type: 'message', role: 'assistant', content: 'hi' }];
  const normalized = protocol.normalizeOutputItems(items);
  expect(normalized).not.toBe(items);
  expect(items[0]).toHaveProperty('id', 'msg-1'); // original unchanged
});

// ---------------------------------------------------------------------------
// Integration: protocol works correctly with ChainedWireState
// ---------------------------------------------------------------------------

it('full lifecycle with Luna protocol mirrors existing ResponsesLiteWireState behavior', () => {
  // This is the same test as in responses-lite-wire-state.test.ts "uses only
  // the input after the stored response items when the logical baseline matches"
  const protocol = new LunaResponsesLiteWireProtocol();
  const state = new ChainedWireState(protocol);
  const key = 'session-1';

  const prefix = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    },
  ];
  const openingUser = { role: 'user', content: 'inspect the repo' };
  const functionCall = {
    type: 'function_call',
    call_id: 'call-1',
    name: 'shell',
    arguments: '{}',
  };
  const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: 'done' };

  state.prepare(key, 'token-1', {
    model: 'gpt-5.6-luna',
    input: [...prefix, openingUser],
  });
  state.recordResponse(key, 'token-1', 'resp-1', [functionCall]);

  const prepared = state.prepare(key, 'token-2', {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [...prefix, openingUser, functionCall, toolOutput],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([toolOutput]);
});
