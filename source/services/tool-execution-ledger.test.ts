import test from 'ava';
import {
  ToolExecutionLedger,
  reconcileHistoryWithToolLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';

test('ToolExecutionLedger records completed function call pairs', (t) => {
  const ledger = new ToolExecutionLedger();

  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-read',
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'source/a.ts' }),
    },
  });
  ledger.recordFunctionResult({
    rawItem: {
      type: 'function_call_result',
      id: 'fcr_1',
      callId: 'call-read',
      name: 'read_file',
      output: 'contents',
    },
  });

  const saved = ledger.export();
  t.is(saved.length, 1);
  t.is(saved[0].status, 'completed');
  t.deepEqual(saved[0].historyItems, [
    {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-read',
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'source/a.ts' }),
    },
    {
      type: 'function_call_result',
      id: 'fcr_1',
      callId: 'call-read',
      name: 'read_file',
      output: 'contents',
    },
  ]);
});

test('ToolExecutionLedger marks unfinished calls as aborted', (t) => {
  const ledger = new ToolExecutionLedger();

  ledger.recordFunctionCall({
    type: 'function_call',
    id: 'fc_1',
    callId: 'call-write',
    name: 'apply_patch',
    arguments: '{}',
  });
  ledger.markOpenCallsAborted('stream failed');

  const saved = ledger.export();
  t.is(saved.length, 1);
  t.is(saved[0].status, 'aborted');
  t.is(saved[0].failureReason, 'stream failed');
  t.is(saved[0].historyItems, undefined);
});

test('reconcileHistoryWithToolLedger appends completed pairs once and drops incomplete calls', (t) => {
  const history = [{ role: 'user', type: 'message', content: 'continue' }];
  const ledger: SavedToolExecution[] = [
    {
      turnId: 'turn-1',
      callId: 'call-read',
      toolName: 'read_file',
      arguments: '{}',
      status: 'completed',
      startedAt: '2026-05-26T00:00:00.000Z',
      completedAt: '2026-05-26T00:00:01.000Z',
      historyItems: [
        { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
        { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
      ],
    },
    {
      turnId: 'turn-1',
      callId: 'call-write',
      toolName: 'apply_patch',
      arguments: '{}',
      status: 'aborted',
      startedAt: '2026-05-26T00:00:02.000Z',
      failureReason: 'stream failed',
    },
  ];

  const first = reconcileHistoryWithToolLedger(history, ledger);
  t.is(first.addedCompletedPairs, 1);
  t.is(first.droppedIncompleteCalls, 1);
  t.is(first.history.length, 3);
  t.is((first.history[1] as any).callId, 'call-read');
  t.is((first.history[2] as any).callId, 'call-read');

  const second = reconcileHistoryWithToolLedger(first.history, ledger);
  t.is(second.addedCompletedPairs, 0);
  t.is(second.history.length, first.history.length);
});

test('reconcileHistoryWithToolLedger restores reasoning items stored with recovered call pairs', (t) => {
  const history = [{ role: 'user', type: 'message', content: 'continue' }];
  const ledger: SavedToolExecution[] = [
    {
      turnId: 'turn-1',
      callId: 'call-read',
      toolName: 'read_file',
      arguments: '{}',
      status: 'completed',
      startedAt: '2026-05-26T00:00:00.000Z',
      completedAt: '2026-05-26T00:00:01.000Z',
      historyItems: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'I should inspect the file.' }],
          rawContent: [{ type: 'reasoning_text', text: 'I should inspect the file.' }],
        },
        { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
        { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
      ],
    },
  ];

  const result = reconcileHistoryWithToolLedger(history, ledger);

  t.is(result.addedCompletedPairs, 1);
  t.is(result.history.length, 4);
  t.is((result.history[1] as any).type, 'reasoning');
  t.is((result.history[1] as any).content[0].text, 'I should inspect the file.');
  t.is((result.history[2] as any).type, 'function_call');
  t.is((result.history[3] as any).type, 'function_call_result');
});

test('recordFunctionCall preserves existing historyItems on a duplicate call', (t) => {
  const ledger = new ToolExecutionLedger();

  // First call: record a function_call
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-dup',
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'a.ts' }),
    },
  });

  const savedBefore = ledger.export();
  t.is(savedBefore.length, 1);
  t.is(savedBefore[0].historyItems!.length, 1, 'initial function_call sets one historyItem');
  t.is((savedBefore[0].historyItems![0] as any).id, 'fc_1');

  // Now simulate a duplicate function_call for the same callId (still 'started' status)
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_2',
      callId: 'call-dup',
      name: 'read_file',
      arguments: JSON.stringify({ file_path: 'b.ts' }),
    },
  });

  const savedAfter = ledger.export();
  t.is(savedAfter.length, 1, 'no new entry created');
  t.is(savedAfter[0].toolName, 'read_file');
  t.is(savedAfter[0].arguments, JSON.stringify({ file_path: 'b.ts' }));
  t.is(savedAfter[0].status, 'started');
  // historyItems should NOT be overwritten — the original fc_1 item is preserved
  t.is(savedAfter[0].historyItems!.length, 1, 'existing historyItems are preserved on duplicate call');
  t.is((savedAfter[0].historyItems![0] as any).id, 'fc_1', 'original historyItem id preserved');
});

test('recordAbortedApproval scopes by callId when provided', (t) => {
  const ledger = new ToolExecutionLedger();

  // Record two function calls with different callIds
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-a',
      name: 'read_file',
      arguments: '{}',
    },
  });
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_2',
      callId: 'call-b',
      name: 'apply_patch',
      arguments: '{}',
    },
  });

  // Abort only call-a
  ledger.recordAbortedApproval('rejected', 'Tool execution was not approved.', 'call-a');

  const saved = ledger.export();
  t.is(saved.length, 2);

  const entryA = saved.find((e) => e.callId === 'call-a')!;
  t.is(entryA.status, 'aborted');
  t.is(entryA.failureReason, 'Tool execution was not approved.');
  t.truthy(entryA.completedAt);
  t.is(entryA.output, 'rejected');
  t.is(entryA.historyItems!.length, 2);
  t.is((entryA.historyItems![1] as any).type, 'function_call_output');
  t.is((entryA.historyItems![1] as any).callId, 'call-a');

  const entryB = saved.find((e) => e.callId === 'call-b')!;
  t.is(entryB.status, 'started', 'call-b should remain started');
});

test('recordAbortedApproval aborts all matching entries when no callId is provided', (t) => {
  const ledger = new ToolExecutionLedger();

  // Record two started calls and one completed call
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-a',
      name: 'read_file',
      arguments: '{}',
    },
  });
  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_2',
      callId: 'call-b',
      name: 'apply_patch',
      arguments: '{}',
    },
  });
  // Complete call-a
  ledger.recordFunctionResult({
    rawItem: {
      type: 'function_call_result',
      id: 'fcr_1',
      callId: 'call-a',
      name: 'read_file',
      output: 'contents',
    },
  });

  // Abort all pending (no callId) — should only affect call-b
  ledger.recordAbortedApproval('batch abort');

  const saved = ledger.export();
  const entryA = saved.find((e) => e.callId === 'call-a')!;
  t.is(entryA.status, 'completed', 'completed call should remain completed');

  const entryB = saved.find((e) => e.callId === 'call-b')!;
  t.is(entryB.status, 'aborted');
  t.is(entryB.historyItems!.length, 2);
  t.is((entryB.historyItems![1] as any).type, 'function_call_output');
});

test('recordAbortedApproval synthesizes function_call_output type items', (t) => {
  const ledger = new ToolExecutionLedger();

  ledger.recordFunctionCall({
    rawItem: {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call-x',
      name: 'shell',
      arguments: '{"command":"echo hi"}',
    },
  });

  ledger.recordAbortedApproval('user cancelled');

  const saved = ledger.export();
  t.is(saved.length, 1);
  t.is(saved[0].status, 'aborted');
  t.is(saved[0].output, 'user cancelled');
  t.truthy(saved[0].historyItems);
  t.is(saved[0].historyItems!.length, 2);
  t.is((saved[0].historyItems![0] as any).type, 'function_call');
  const resultItem = saved[0].historyItems![1] as Record<string, unknown>;
  t.is(resultItem.type, 'function_call_output');
  t.is(resultItem.callId, 'call-x');
  t.is(resultItem.output, 'user cancelled');
  // Should NOT have role: 'tool' or type: 'tool_call_output_item'
  t.is((resultItem as any).role, undefined);
});

test('reconcileHistoryWithToolLedger does NOT count started or approval_required entries as dropped', (t) => {
  const history = [{ role: 'user', type: 'message', content: 'continue' }];
  const ledger: SavedToolExecution[] = [
    {
      turnId: 'turn-1',
      callId: 'call-started',
      toolName: 'read_file',
      arguments: '{}',
      status: 'started',
      startedAt: '2026-05-26T00:00:00.000Z',
      historyItems: [{ type: 'function_call', id: 'fc_1', callId: 'call-started', name: 'read_file', arguments: '{}' }],
    },
    {
      turnId: 'turn-1',
      callId: 'call-approval',
      toolName: 'apply_patch',
      arguments: '{}',
      status: 'approval_required',
      startedAt: '2026-05-26T00:00:01.000Z',
      historyItems: [
        { type: 'function_call', id: 'fc_2', callId: 'call-approval', name: 'apply_patch', arguments: '{}' },
      ],
    },
    {
      turnId: 'turn-1',
      callId: 'call-aborted',
      toolName: 'shell',
      arguments: '{}',
      status: 'aborted',
      startedAt: '2026-05-26T00:00:02.000Z',
      failureReason: 'user rejected',
    },
  ];

  const result = reconcileHistoryWithToolLedger(history, ledger);
  // Only the 'aborted' entry should be counted as dropped, not 'started' or 'approval_required'
  t.is(result.droppedIncompleteCalls, 1);
  t.is(result.addedCompletedPairs, 0);
});
