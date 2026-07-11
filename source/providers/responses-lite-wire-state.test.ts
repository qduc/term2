import { expect, it } from 'vitest';
import { ResponsesLiteWireState } from './responses-lite-wire-state.js';

it('uses only the input after the stored response items when the logical baseline matches', () => {
  const state = new ResponsesLiteWireState();
  const key = 'session-1';
  const prefix = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    },
  ];
  const openingUser = { role: 'user', content: 'inspect the repo' };
  const functionCall = { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' };
  const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: 'done' };

  state.prepare(key, {
    model: 'gpt-5.6-luna',
    input: [...prefix, openingUser],
  });
  state.recordResponse(key, 'resp-1', [functionCall]);

  const prepared = state.prepare(key, {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [...prefix, openingUser, functionCall, toolOutput],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([toolOutput]);
});

it('keeps the full prefix when the available tool set changes', () => {
  const state = new ResponsesLiteWireState();
  const key = 'session-2';
  const firstPrefix = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
  };
  const changedPrefix = {
    ...firstPrefix,
    tools: [{ type: 'function', name: 'apply_patch', parameters: { type: 'object' } }],
  };

  state.prepare(key, { model: 'gpt-5.6-luna', input: [firstPrefix] });
  state.recordResponse(key, 'resp-1', []);

  const prepared = state.prepare(key, {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [changedPrefix, { role: 'user', content: 'continue' }],
  });

  expect(prepared.usedDelta).toBe(false);
  expect(prepared.requestData.input).toEqual([changedPrefix, { role: 'user', content: 'continue' }]);
});

it('matches replayed response items after their server ids are stripped', () => {
  const state = new ResponsesLiteWireState();
  const key = 'session-3';
  const prefix = {
    type: 'additional_tools',
    role: 'developer',
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
  };
  const openingUser = { role: 'user', content: 'inspect the repo' };
  const responseFunctionCall = {
    id: 'fc-server-id',
    type: 'function_call',
    call_id: 'call-1',
    name: 'shell',
    arguments: '{}',
  };
  const { id: _serverId, ...replayedFunctionCall } = responseFunctionCall;
  const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: 'done' };

  state.prepare(key, {
    model: 'gpt-5.6-luna',
    input: [prefix, openingUser],
  });
  state.recordResponse(key, 'resp-1', [responseFunctionCall]);

  const prepared = state.prepare(key, {
    model: 'gpt-5.6-luna',
    previous_response_id: 'resp-1',
    input: [prefix, openingUser, replayedFunctionCall, toolOutput],
  });

  expect(prepared.usedDelta).toBe(true);
  expect(prepared.requestData.input).toEqual([toolOutput]);
});
