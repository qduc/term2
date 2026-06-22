import { it, expect } from 'vitest';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import type { AgentInputItem } from '@openai/agents';

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

it('recoverApprovedResultsFromState recovers all generated tool outputs, not just expected call IDs', () => {
  const store = new ConversationStore();
  const tracker = new SessionToolTracker(store);
  tracker.beginTurn();

  // Simulate function calls observed during streaming (onFunctionCallItem).
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_1', callId: 'call-a', name: 'shell', arguments: '{}' },
  });
  tracker.recordFunctionCall({
    rawItem: { type: 'function_call', id: 'fc_2', callId: 'call-b', name: 'read_file', arguments: '{}' },
  });

  // Store only has the user message — in delta/chaining mode the turn's tool
  // outputs never reach the store (finalize is partial while approvals pend).
  store.addUserMessage('do the thing');

  // _generatedItems carries outputs for BOTH calls, but expectedCallIds only
  // names the latest delta's call (the one being submitted when transport failed).
  const runState = {
    _generatedItems: [
      { type: 'function_call_output', callId: 'call-a', output: 'result-a' },
      { type: 'function_call_output', callId: 'call-b', output: 'result-b' },
    ],
  };

  tracker.recoverApprovedResultsFromState(runState, ['call-b']);

  const history = tracker.getReconciledHistory() as AgentInputItem[];
  const outputs = history.filter((item) => {
    const type = (item as { type?: string }).type;
    return type === 'function_call_output' || type === 'function_call_result';
  });
  const callIds = outputs.map(
    (item) => (item as { callId?: string; call_id?: string }).callId ?? (item as { call_id?: string }).call_id,
  );

  // Both calls' outputs must be recovered, not just call-b.
  expect(callIds).toContain('call-a');
  expect(callIds).toContain('call-b');
});
