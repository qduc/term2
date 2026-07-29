import { expect, it } from 'vitest';
import { normalizeRunItem, normalizeRunItems } from './run-item-normalizer.js';

it('normalizes direct and wrapped reasoning items while preserving provider metadata', () => {
  const direct = {
    type: 'reasoning',
    id: 'reasoning-1',
    index: 3,
    rawContent: [{ type: 'reasoning_text', text: 'Consider the request.' }],
    providerData: { reasoning_details: [{ type: 'summary', text: 'considered' }] },
  };
  const wrapped = { rawItem: direct };

  expect(normalizeRunItem(direct)).toEqual([
    {
      type: 'reasoning',
      text: 'Consider the request.',
      providerItemId: 'reasoning-1',
      sequence: 3,
      providerMetadata: { reasoning_details: [{ type: 'summary', text: 'considered' }] },
    },
  ]);
  expect(normalizeRunItem(wrapped)).toEqual(normalizeRunItem(direct));
});

it('normalizes assistant messages and separates their reasoning metadata', () => {
  expect(
    normalizeRunItem({
      role: 'assistant',
      type: 'message',
      id: 'message-1',
      content: [{ type: 'output_text', text: 'Done.' }],
      providerData: { reasoning_content: 'I checked it.', model_trace: 'trace-1' },
    }),
  ).toEqual([
    {
      type: 'reasoning',
      text: 'I checked it.',
      providerMetadata: { reasoning_content: 'I checked it.', model_trace: 'trace-1' },
    },
    {
      type: 'assistant_text',
      text: 'Done.',
      providerItemId: 'message-1',
      providerMetadata: { reasoning_content: 'I checked it.', model_trace: 'trace-1' },
    },
  ]);
});

it('normalizes function and apply-patch calls with supported call identifier variants', () => {
  expect(
    normalizeRunItems([
      { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
      { type: 'apply_patch_call', tool_call_id: 'call-2', name: 'apply_patch', args: '*** Begin Patch' },
      { type: 'function_call', id: 'call-3', name: 'read_file' },
    ]),
  ).toEqual([
    {
      type: 'tool_call',
      callId: 'call-1',
      toolName: 'shell',
      arguments: { command: 'pwd' },
      providerItem: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: { command: 'pwd' } },
    },
    {
      type: 'tool_call',
      callId: 'call-2',
      toolName: 'apply_patch',
      arguments: '*** Begin Patch',
      providerItem: { type: 'apply_patch_call', tool_call_id: 'call-2', name: 'apply_patch', args: '*** Begin Patch' },
    },
    {
      type: 'tool_call',
      callId: 'call-3',
      toolName: 'read_file',
      arguments: undefined,
      providerItem: { type: 'function_call', id: 'call-3', name: 'read_file' },
    },
  ]);
});

it.each([
  'function_call_result',
  'function_call_output',
  'function_call_output_result',
  'tool_call_output_item',
  'shell_call_output',
  'tool_call_output',
  'tool_call_result',
  'local_shell_call_output',
  'computer_call_output',
  'computer_call_result',
  'apply_patch_call_output',
])('normalizes supported %s tool-result spelling', (type) => {
  expect(normalizeRunItem({ type, callId: 'call-1', name: 'shell', output: 'ok' })).toEqual([
    {
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'shell',
      status: 'completed',
      output: 'ok',
      providerItem: { type, callId: 'call-1', name: 'shell', output: 'ok' },
    },
  ]);
});

it('normalizes the legacy store tool_result spelling when it has provider-style fields', () => {
  expect(normalizeRunItem({ type: 'tool_result', callId: 'call-1', name: 'shell', output: 'ok' })).toMatchObject([
    { type: 'tool_result', callId: 'call-1', toolName: 'shell', output: 'ok' },
  ]);
});

it('preserves the outer wrapper output and accepts direct or wrapped canonical items', () => {
  const canonical = {
    type: 'tool_result' as const,
    callId: 'call-canonical',
    toolName: 'shell',
    status: 'completed' as const,
    output: 'ok',
  };

  expect(
    normalizeRunItem({
      rawItem: { type: 'function_call_result', callId: 'call-outer', name: 'shell' },
      output: 'outer',
    }),
  ).toMatchObject([{ output: 'outer', toolName: 'shell' }]);
  expect(normalizeRunItem(canonical)).toEqual([canonical]);
  expect(normalizeRunItem({ rawItem: canonical })).toEqual([canonical]);
});

it('prefers wrapper call identity over conflicting provider-item identity', () => {
  expect(
    normalizeRunItem({
      type: 'function_call_output',
      callId: 'outer-call',
      rawItem: { type: 'function_call_output', callId: 'provider-call', output: 'done' },
    }),
  ).toMatchObject([{ type: 'tool_result', callId: 'outer-call' }]);
});

it('returns no items for unknown values and preserves multi-item ordering', () => {
  expect(normalizeRunItem({ type: 'unknown' })).toEqual([]);
  expect(normalizeRunItem(null)).toEqual([]);
  expect(normalizeRunItems(undefined)).toEqual([]);
  expect(
    normalizeRunItems([
      { type: 'reasoning', text: 'First.' },
      { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'Second.' }] },
      { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
    ]),
  ).toMatchObject([
    { type: 'reasoning', text: 'First.' },
    { type: 'assistant_text', text: 'Second.' },
    { type: 'tool_call', callId: 'call-1' },
  ]);
});
