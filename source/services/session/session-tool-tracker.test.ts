import { it, expect } from 'vitest';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';

it('dedupeToolStarted scopes subagent starts by agent and call ID', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  const event = {
    type: 'subagent_tool_started' as const,
    agentId: 'worker-1',
    role: 'worker',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'pwd' },
  };

  expect(tracker.dedupeToolStarted(event)).toBe(event);
  expect(tracker.dedupeToolStarted(event)).toBe(null);
  expect(tracker.dedupeToolStarted({ ...event, agentId: 'worker-2' })).toBeTruthy();
});

it('activeCallIdsForCurrentTurn returns empty array for a fresh tracker', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  expect(tracker.activeCallIdsForCurrentTurn()).toEqual([]);
});

it('activeCallIdsForCurrentTurn delegates to the ledger for the current turn', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  tracker.beginTurn();
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-a', name: 'read_file', arguments: '{}' },
  });
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-b', name: 'shell', arguments: '{}' },
  });

  expect(tracker.activeCallIdsForCurrentTurn()).toEqual(['call-a', 'call-b']);
});

it('completedResultCallIdsForCurrentTurn exposes only completed current-turn results', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  tracker.beginTurn();
  tracker.recordFunctionCall({ type: 'function_call', callId: 'call-completed', name: 'shell', arguments: '{}' });
  tracker.recordFunctionResult({ type: 'function_call_output', callId: 'call-completed', output: 'ok' });
  tracker.recordFunctionCall({ type: 'function_call', callId: 'call-pending', name: 'shell', arguments: '{}' });

  expect(tracker.completedResultCallIdsForCurrentTurn()).toEqual(['call-completed']);
});

it('unsettledToolCallIdsForCurrentTurn excludes completed results only', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  tracker.beginTurn();
  tracker.recordFunctionCall({ type: 'function_call', callId: 'call-completed', name: 'shell', arguments: '{}' });
  tracker.recordFunctionResult({ type: 'function_call_output', callId: 'call-completed', output: 'ok' });
  tracker.recordFunctionCall({ type: 'function_call', callId: 'call-pending', name: 'shell', arguments: '{}' });
  tracker.recordFunctionCall({ type: 'function_call', callId: 'call-aborted', name: 'shell', arguments: '{}' });
  tracker.recordAbortedApproval('failed', 'Stream failed', 'call-aborted');

  expect(tracker.unsettledToolCallIdsForCurrentTurn()).toEqual(['call-pending', 'call-aborted']);
});

it('activeCallIdsForCurrentTurn includes aborted call IDs (provider requires output for every call)', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  tracker.beginTurn();
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-rejected', name: 'apply_patch', arguments: '{}' },
  });
  tracker.recordAbortedApproval('user rejected', 'Tool execution was not approved.', 'call-rejected');

  expect(tracker.activeCallIdsForCurrentTurn()).toEqual(['call-rejected']);
});

it('activeCallIdsForCurrentTurn only returns entries for the current turn across multiple turns', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  tracker.beginTurn();
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-prior', name: 'read_file', arguments: '{}' },
  });
  tracker.beginTurn();
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-now', name: 'shell', arguments: '{}' },
  });

  expect(tracker.activeCallIdsForCurrentTurn()).toEqual(['call-now']);
});
