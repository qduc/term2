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
  t.is(first.history.length, 4);
  t.is((first.history[1] as any).callId, 'call-read');
  t.is((first.history[2] as any).callId, 'call-read');
  t.is((first.history[3] as any).role, 'system');

  const second = reconcileHistoryWithToolLedger(first.history, ledger);
  t.is(second.addedCompletedPairs, 0);
  t.is(second.history.length, first.history.length);
});
