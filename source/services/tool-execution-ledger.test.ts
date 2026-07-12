import { it, expect } from 'vitest';
import {
  ToolExecutionLedger,
  reconcileHistoryWithToolLedger,
  dropUnpairedFunctionCalls,
  sanitizeMalformedToolCallArguments,
  hasMalformedToolCallArguments,
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

it('activeCallIdsForTurn returns empty array for a fresh ledger', () => {
  const ledger = new ToolExecutionLedger();
  expect(ledger.activeCallIdsForTurn()).toEqual([]);
});

it('activeCallIdsForTurn returns call IDs only for the current turn', () => {
  const ledger = new ToolExecutionLedger();
  ledger.beginTurn();
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-a', name: 'read_file', arguments: '{}' },
  });
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-b', name: 'shell', arguments: '{}' },
  });

  expect(ledger.activeCallIdsForTurn()).toEqual(['call-a', 'call-b']);
});

it('activeCallIdsForTurn includes call IDs regardless of status', () => {
  const ledger = new ToolExecutionLedger();
  ledger.beginTurn();
  // started
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-started', name: 'read_file', arguments: '{}' },
  });
  // completed
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-completed', name: 'shell', arguments: '{}' },
  });
  ledger.recordFunctionResult({
    rawItem: {
      type: 'function_call_result',
      id: 'fcr_1',
      callId: 'call-completed',
      name: 'shell',
      output: 'done',
    },
  });
  // aborted
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_3', callId: 'call-aborted', name: 'apply_patch', arguments: '{}' },
  });
  ledger.recordAbortedApproval('rejected');

  const callIds = ledger.activeCallIdsForTurn();
  expect(callIds).toEqual(['call-started', 'call-completed', 'call-aborted']);
});

it('activeCallIdsForTurn defaults to the current turn when no argument given', () => {
  const ledger = new ToolExecutionLedger();
  ledger.beginTurn();
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-current', name: 'read_file', arguments: '{}' },
  });

  expect(ledger.activeCallIdsForTurn()).toEqual(['call-current']);
});

it('activeCallIdsForTurn excludes entries from other turns', () => {
  const ledger = new ToolExecutionLedger();
  ledger.beginTurn();
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-prior', name: 'read_file', arguments: '{}' },
  });
  ledger.beginTurn();
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-now', name: 'shell', arguments: '{}' },
  });

  expect(ledger.activeCallIdsForTurn()).toEqual(['call-now']);
  expect(ledger.activeCallIdsForTurn('turn-1')).toEqual(['call-prior']);
});

it('activeCallIdsForTurn includes aborted/rejected call IDs (regression: provider requires output for every call)', () => {
  const ledger = new ToolExecutionLedger();
  ledger.beginTurn();
  ledger.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-rejected', name: 'apply_patch', arguments: '{}' },
  });
  ledger.recordAbortedApproval('user rejected', 'Tool execution was not approved.', 'call-rejected');

  // The aborted call ID must be present so the chained-input filter keeps its
  // synthetic output — provider APIs reject assistant turns missing a tool output.
  expect(ledger.activeCallIdsForTurn()).toEqual(['call-rejected']);
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

it('dropUnpairedFunctionCalls removes function_calls without a matching output', () => {
  const history = [
    { role: 'user' as const, type: 'message', content: 'do work' },
    { type: 'function_call', id: 'fc_1', call_id: 'call-paired', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-paired', output: 'ok' },
    { type: 'function_call', id: 'fc_2', call_id: 'call-orphan', name: 'read_file', arguments: '{}' },
    { type: 'function_call', id: 'fc_3', call_id: 'call-orphan-2', name: 'shell', arguments: '{}' },
  ];

  const result = dropUnpairedFunctionCalls(history);
  const callIds = result.map((item) => (item as { call_id?: string }).call_id).filter(Boolean);
  expect(callIds).toEqual(['call-paired', 'call-paired']);
  expect(result.length).toBe(3);
});

it('dropUnpairedFunctionCalls removes function_call_outputs without a matching call', () => {
  const history = [
    { role: 'user' as const, type: 'message', content: 'do work' },
    { type: 'function_call_output', call_id: 'call-already-consumed', output: 'old result' },
    { type: 'function_call', id: 'fc_1', call_id: 'call-current', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-current', output: 'current result' },
  ];

  const result = dropUnpairedFunctionCalls(history);
  const callIds = result.map((item) => (item as { call_id?: string }).call_id).filter(Boolean);
  expect(callIds).toEqual(['call-current', 'call-current']);
  expect(result.length).toBe(3);
});

it('dropUnpairedFunctionCalls leaves non-tool items untouched', () => {
  const history = [
    { role: 'user' as const, type: 'message', content: 'hi' },
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'function_call', id: 'fc_1', call_id: 'call-orphan', name: 'shell', arguments: '{}' },
    { type: 'message', role: 'assistant' as const, content: [{ type: 'output_text', text: 'done' }] },
  ];

  const result = dropUnpairedFunctionCalls(history);
  expect(result.length).toBe(3);
  expect((result[0] as { content: string }).content).toBe('hi');
  expect((result[1] as { type: string }).type).toBe('reasoning');
  expect((result[2] as { role: string }).role).toBe('assistant');
});

it('dropUnpairedFunctionCalls is a no-op when all calls have outputs', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'result-a' },
  ];

  const result = dropUnpairedFunctionCalls(history);
  expect(result).toBe(history);
});

// ---- sanitizeMalformedToolCallArguments ----

it('sanitizeMalformedToolCallArguments replaces malformed JSON arguments with empty object', () => {
  const history = [
    { role: 'user' as const, type: 'message', content: 'do work' },
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"command":"ls",' },
    { type: 'function_call_output', call_id: 'call-a', output: 'error: malformed arguments' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  const fc = result.find((item) => (item as { type?: string }).type === 'function_call') as Record<string, unknown>;
  expect(fc.arguments).toBe('{}');
  // Non-function_call items are untouched
  const userMsg = result[0] as Record<string, unknown>;
  expect(userMsg.content).toBe('do work');
  const output = result.find((item) => (item as { type?: string }).type === 'function_call_output') as Record<
    string,
    unknown
  >;
  expect(output.output).toBe('error: malformed arguments');
});

it('sanitizeMalformedToolCallArguments leaves valid JSON arguments untouched', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"command":"echo hi"}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'hi' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  expect(result).toBe(history);
});

it('sanitizeMalformedToolCallArguments leaves non-string arguments untouched', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: { command: 'ls' } },
    { type: 'function_call_output', call_id: 'call-a', output: 'ok' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  expect(result).toBe(history);
});

it('sanitizeMalformedToolCallArguments is a no-op when no function_calls exist', () => {
  const history = [
    { role: 'user' as const, type: 'message', content: 'hello' },
    { role: 'assistant' as const, type: 'message', content: [{ type: 'output_text', text: 'hi there' }] },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  expect(result).toBe(history);
});

it('sanitizeMalformedToolCallArguments handles empty/undefined arguments', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell' },
    { type: 'function_call', id: 'fc_2', call_id: 'call-b', name: 'shell', arguments: '' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  expect(result).toBe(history);
});

it('sanitizeMalformedToolCallArguments handles nested rawItem wrapper', () => {
  const history = [
    {
      rawItem: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call-a',
        name: 'shell',
        arguments: '{"command":"ls",',
      },
    },
    { type: 'function_call_output', call_id: 'call-a', output: 'ok' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  const fc = result[0] as Record<string, unknown>;
  const raw = (fc.rawItem ?? fc) as Record<string, unknown>;
  expect(raw.arguments).toBe('{}');
});

it('sanitizeMalformedToolCallArguments handles multiple malformed calls', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"cmd' },
    { type: 'function_call_output', call_id: 'call-a', output: 'r1' },
    { type: 'function_call', id: 'fc_2', call_id: 'call-b', name: 'read_file', arguments: '{"path":"/tmp' },
    { type: 'function_call_output', call_id: 'call-b', output: 'r2' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  const calls = result.filter((item) => (item as { type?: string }).type === 'function_call') as Record<
    string,
    unknown
  >[];
  expect(calls.every((fc) => fc.arguments === '{}')).toBe(true);
});

it('sanitizeMalformedToolCallArguments does not mutate the original array', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"broken' },
    { type: 'function_call_output', call_id: 'call-a', output: 'ok' },
  ];

  const result = sanitizeMalformedToolCallArguments(history);
  expect(result).not.toBe(history);
  const originalFc = history[0] as Record<string, unknown>;
  expect(originalFc.arguments).toBe('{"broken');
  const sanitizedFc = result[0] as Record<string, unknown>;
  expect(sanitizedFc.arguments).toBe('{}');
});

// ---- hasMalformedToolCallArguments ----

it('hasMalformedToolCallArguments returns true when any function_call has malformed JSON', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"command":"echo hi"}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'hi' },
    { type: 'function_call', id: 'fc_2', call_id: 'call-b', name: 'read_file', arguments: '{"path":"/tmp' },
  ];

  expect(hasMalformedToolCallArguments(history)).toBe(true);
});

it('hasMalformedToolCallArguments returns false when all arguments are valid JSON', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'done' },
  ];

  expect(hasMalformedToolCallArguments(history)).toBe(false);
});

it('hasMalformedToolCallArguments returns false when arguments are non-string objects', () => {
  const history = [
    { type: 'function_call', id: 'fc_1', call_id: 'call-a', name: 'shell', arguments: { command: 'ls' } },
  ];

  expect(hasMalformedToolCallArguments(history)).toBe(false);
});

it('hasMalformedToolCallArguments returns false when no function_calls exist', () => {
  const history = [{ role: 'user' as const, type: 'message', content: 'hello' }];

  expect(hasMalformedToolCallArguments(history)).toBe(false);
});
