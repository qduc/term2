import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { repairConversationHistory } from './conversation-history-repair.js';

it('repairConversationHistory collapses repeated full-history tool replay into the latest transcript', () => {
  const history = [
    { role: 'user', type: 'message', content: 'Investigate upgrade' },
    { type: 'function_call', callId: 'call-search', name: 'web_search', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-search', name: 'web_search', output: 'search results' },
    { role: 'user', type: 'message', content: 'Investigate upgrade' },
    { type: 'function_call', callId: 'call-search', name: 'web_search', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-search', name: 'web_search', output: 'search results' },
    { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-read', name: 'read_file', output: 'file contents' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  ];

  const result = repairConversationHistory(history);

  expect(result.repaired).toBe(true);
  expect(result.statsBefore.count).toBe(9);
  expect(result.statsAfter.count).toBe(6);
  expect(result.repairs[0]?.kind).toBe('replayed_full_history_prefix');
  expect((result.history[0] as any).content).toBe('Investigate upgrade');
  expect((result.history[5] as any).role).toBe('assistant');
  expect(result.history.filter((item: any) => item.callId === 'call-search').length).toBe(2);
  expect(result.history.filter((item: any) => item.callId === 'call-read').length).toBe(2);
});

it('repairConversationHistory removes duplicate tool pairs with stable callId and changed SDK ids', () => {
  const history = [
    { role: 'user', type: 'message', content: 'Inspect the repo' },
    { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
    { type: 'function_call', id: 'fc_1_replayed', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1_replayed', callId: 'call-read', output: 'contents' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  ];

  const result = repairConversationHistory(history);

  expect(result.repaired).toBe(true);
  expect(result.repairs.at(-1)?.kind).toBe('duplicated_tool_call_result_pair');
  expect(result.history.length).toBe(4);
  expect(result.history.filter((item: any) => item.callId === 'call-read').map((item: any) => item.id)).toEqual([
    'fc_1',
    'fcr_1',
  ]);
});

it('repairConversationHistory leaves repeated user and assistant text unchanged without duplicated tool pairs', () => {
  const history = [
    { role: 'user', type: 'message', content: 'again' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
    { role: 'user', type: 'message', content: 'again' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
  ];

  const result = repairConversationHistory(history);

  expect(result.repaired).toBe(false);
  expect(result.history).toEqual(history);
});

it('repairConversationHistory leaves valid distinct tool calls unchanged', () => {
  const history = [
    { role: 'user', type: 'message', content: 'Inspect' },
    { type: 'function_call', callId: 'call-read-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-read-1', output: 'one' },
    { type: 'function_call', callId: 'call-read-2', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-read-2', output: 'two' },
  ];

  const result = repairConversationHistory(history);

  expect(result.repaired).toBe(false);
  expect(result.history).toEqual(history);
});

it('repairConversationHistory handles rawItem wrappers and camel or snake call id fields', () => {
  const history = [
    { rawItem: { role: 'user', type: 'message', content: 'Run tools' } },
    { rawItem: { type: 'function_call', call_id: 'call-shell', id: 'fc_1', name: 'shell', arguments: '{}' } },
    { rawItem: { type: 'function_call_result', tool_call_id: 'call-shell', id: 'fcr_1', output: 'ok' } },
    { rawItem: { type: 'function_call', callId: 'call-shell', id: 'fc_2', name: 'shell', arguments: '{}' } },
    { rawItem: { type: 'function_call_result', call_id: 'call-shell', id: 'fcr_2', output: 'ok' } },
  ];

  const result = repairConversationHistory(history);

  expect(result.repaired).toBe(true);
  expect(result.history.length).toBe(3);
  expect(result.history.slice(1).map((item: any) => item.rawItem.id)).toEqual(['fc_1', 'fcr_1']);
});
