import { it, expect } from 'vitest';
import { ApprovalState } from './approval-state.js';

it('set/get pending context', () => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' } as any,
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
    owner: { kind: 'parent' as const },
  };

  state.setPending(pending);

  expect(state.getPending()).toBe(pending);
});

it('abortPending() moves pending to aborted and clears pending', () => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' } as any,
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
    owner: { kind: 'subagent' as const, agentId: 'worker-1', role: 'worker' },
  };

  state.setPending(pending);
  state.abortPending();

  expect(state.getPending()).toBe(null);

  const aborted = state.consumeAborted();
  expect(aborted).toBeTruthy();
  expect(aborted?.state).toBe(pending.state);
  expect(aborted?.interruption).toBe(pending.interruption);
  expect(aborted?.emittedCommandIds).toEqual(pending.emittedCommandIds);
  expect(aborted?.toolCallArgumentsById).toEqual(pending.toolCallArgumentsById);
  expect(aborted?.owner).toEqual(pending.owner);
});

it('consumeAborted() returns aborted context and clears it', () => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' } as any,
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
  };

  state.setPending(pending);
  state.abortPending();

  const aborted = state.consumeAborted();
  expect(aborted).toBeTruthy();
  expect(state.consumeAborted()).toBe(null);
});

it('abortPending carries forward batch decisions and the prompted call', () => {
  const state = new ApprovalState();
  const interruptions = [
    { name: 'read_file', callId: 'read-1' },
    { name: 'shell', callId: 'shell-1' },
  ];
  const decisionsByCallId = new Map([['read-1', 'approved' as const]]);

  state.setPending({
    state: { id: 'state' } as any,
    interruption: interruptions[1],
    interruptions,
    decisionsByCallId,
    promptedCallId: 'shell-1',
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  state.abortPending();

  const aborted = state.consumeAborted();
  expect(aborted?.interruptions).toBe(interruptions);
  expect(aborted?.decisionsByCallId).toBe(decisionsByCallId);
  expect(aborted?.promptedCallId).toBe('shell-1');
});
