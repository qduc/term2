import test from 'ava';

import { repairConversationHistory } from './conversation-history-repair.js';

test('repairConversationHistory collapses repeated full-history tool replay into the latest transcript', (t) => {
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

  t.true(result.repaired);
  t.is(result.statsBefore.count, 9);
  t.is(result.statsAfter.count, 6);
  t.is(result.repairs[0]?.kind, 'replayed_full_history_prefix');
  t.is((result.history[0] as any).content, 'Investigate upgrade');
  t.is((result.history[5] as any).role, 'assistant');
  t.is(result.history.filter((item: any) => item.callId === 'call-search').length, 2);
  t.is(result.history.filter((item: any) => item.callId === 'call-read').length, 2);
});

test('repairConversationHistory removes duplicate tool pairs with stable callId and changed SDK ids', (t) => {
  const history = [
    { role: 'user', type: 'message', content: 'Inspect the repo' },
    { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
    { type: 'function_call', id: 'fc_1_replayed', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1_replayed', callId: 'call-read', output: 'contents' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  ];

  const result = repairConversationHistory(history);

  t.true(result.repaired);
  t.is(result.repairs.at(-1)?.kind, 'duplicated_tool_call_result_pair');
  t.is(result.history.length, 4);
  t.deepEqual(
    result.history.filter((item: any) => item.callId === 'call-read').map((item: any) => item.id),
    ['fc_1', 'fcr_1'],
  );
});

test('repairConversationHistory leaves repeated user and assistant text unchanged without duplicated tool pairs', (t) => {
  const history = [
    { role: 'user', type: 'message', content: 'again' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
    { role: 'user', type: 'message', content: 'again' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
  ];

  const result = repairConversationHistory(history);

  t.false(result.repaired);
  t.deepEqual(result.history, history);
});

test('repairConversationHistory leaves valid distinct tool calls unchanged', (t) => {
  const history = [
    { role: 'user', type: 'message', content: 'Inspect' },
    { type: 'function_call', callId: 'call-read-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-read-1', output: 'one' },
    { type: 'function_call', callId: 'call-read-2', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-read-2', output: 'two' },
  ];

  const result = repairConversationHistory(history);

  t.false(result.repaired);
  t.deepEqual(result.history, history);
});

test('repairConversationHistory handles rawItem wrappers and camel or snake call id fields', (t) => {
  const history = [
    { rawItem: { role: 'user', type: 'message', content: 'Run tools' } },
    { rawItem: { type: 'function_call', call_id: 'call-shell', id: 'fc_1', name: 'shell', arguments: '{}' } },
    { rawItem: { type: 'function_call_result', tool_call_id: 'call-shell', id: 'fcr_1', output: 'ok' } },
    { rawItem: { type: 'function_call', callId: 'call-shell', id: 'fc_2', name: 'shell', arguments: '{}' } },
    { rawItem: { type: 'function_call_result', call_id: 'call-shell', id: 'fcr_2', output: 'ok' } },
  ];

  const result = repairConversationHistory(history);

  t.true(result.repaired);
  t.is(result.history.length, 3);
  t.deepEqual(
    result.history.slice(1).map((item: any) => item.rawItem.id),
    ['fc_1', 'fcr_1'],
  );
});
