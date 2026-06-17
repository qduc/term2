import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  ToolExecutionLedger,
  reconcileHistoryWithToolLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';

it('ToolExecutionLedger records completed function call pairs', () => {
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
  expect(saved.length).toBe(1);
  expect(saved[0].status).toBe('completed');
  expect(saved[0].historyItems).toEqual([
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

it('ToolExecutionLedger marks unfinished calls as aborted', () => {
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
  expect(saved.length).toBe(1);
  expect(saved[0].status).toBe('aborted');
  expect(saved[0].failureReason).toBe('stream failed');
  expect(saved[0].historyItems).toBe(undefined);
});

it('reconcileHistoryWithToolLedger appends completed pairs once and drops incomplete calls', () => {
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
  expect(first.addedCompletedPairs).toBe(1);
  expect(first.droppedIncompleteCalls).toBe(1);
  expect(first.history.length).toBe(3);
  expect((first.history[1] as any).callId).toBe('call-read');
  expect((first.history[2] as any).callId).toBe('call-read');

  const second = reconcileHistoryWithToolLedger(first.history, ledger);
  expect(second.addedCompletedPairs).toBe(0);
  expect(second.history.length).toBe(first.history.length);
});

it('reconcileHistoryWithToolLedger restores reasoning items stored with recovered call pairs', () => {
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

  expect(result.addedCompletedPairs).toBe(1);
  expect(result.history.length).toBe(4);
  expect((result.history[1] as any).type).toBe('reasoning');
  expect((result.history[1] as any).content[0].text).toBe('I should inspect the file.');
  expect((result.history[2] as any).type).toBe('function_call');
  expect((result.history[3] as any).type).toBe('function_call_result');
});

it('recordFunctionCall preserves existing historyItems on a duplicate call', () => {
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
  expect(savedBefore.length).toBe(1);
  expect(savedBefore[0].historyItems!.length, 'initial function_call sets one historyItem').toBe(1);
  expect((savedBefore[0].historyItems![0] as any).id).toBe('fc_1');

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
  expect(savedAfter.length, 'no new entry created').toBe(1);
  expect(savedAfter[0].toolName).toBe('read_file');
  expect(savedAfter[0].arguments).toBe(JSON.stringify({ file_path: 'b.ts' }));
  expect(savedAfter[0].status).toBe('started');
  // historyItems should NOT be overwritten — the original fc_1 item is preserved
  expect(savedAfter[0].historyItems!.length, 'existing historyItems are preserved on duplicate call').toBe(1);
  expect((savedAfter[0].historyItems![0] as any).id, 'original historyItem id preserved').toBe('fc_1');
});

it('recordAbortedApproval scopes by callId when provided', () => {
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
  expect(saved.length).toBe(2);

  const entryA = saved.find((e) => e.callId === 'call-a')!;
  expect(entryA.status).toBe('aborted');
  expect(entryA.failureReason).toBe('Tool execution was not approved.');
  expect(entryA.completedAt).toBeTruthy();
  expect(entryA.output).toBe('rejected');
  expect(entryA.historyItems!.length).toBe(2);
  expect((entryA.historyItems![1] as any).type).toBe('function_call_output');
  expect((entryA.historyItems![1] as any).callId).toBe('call-a');

  const entryB = saved.find((e) => e.callId === 'call-b')!;
  expect(entryB.status, 'call-b should remain started').toBe('started');
});

it('recordAbortedApproval aborts all matching entries when no callId is provided', () => {
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
  expect(entryA.status, 'completed call should remain completed').toBe('completed');

  const entryB = saved.find((e) => e.callId === 'call-b')!;
  expect(entryB.status).toBe('aborted');
  expect(entryB.historyItems!.length).toBe(2);
  expect((entryB.historyItems![1] as any).type).toBe('function_call_output');
});

it('recordAbortedApproval synthesizes function_call_output type items', () => {
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
  expect(saved.length).toBe(1);
  expect(saved[0].status).toBe('aborted');
  expect(saved[0].output).toBe('user cancelled');
  expect(saved[0].historyItems).toBeTruthy();
  expect(saved[0].historyItems!.length).toBe(2);
  expect((saved[0].historyItems![0] as any).type).toBe('function_call');
  const resultItem = saved[0].historyItems![1] as Record<string, unknown>;
  expect(resultItem.type).toBe('function_call_output');
  expect(resultItem.callId).toBe('call-x');
  expect(resultItem.output).toBe('user cancelled');
  // Should NOT have role: 'tool' or type: 'tool_call_output_item'
  expect((resultItem as any).role).toBe(undefined);
});

it('reconcileHistoryWithToolLedger does NOT count started or approval_required entries as dropped', () => {
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
  expect(result.droppedIncompleteCalls).toBe(1);
  expect(result.addedCompletedPairs).toBe(0);
});
