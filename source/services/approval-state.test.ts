import test from 'ava';
import { ApprovalState } from './approval-state.js';

test('set/get pending context', (t) => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' },
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
  };

  state.setPending(pending);

  t.is(state.getPending(), pending);
});

test('setPendingRemoveInterceptor stores cleanup on pending', (t) => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' },
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map(),
  };
  const removeInterceptor = () => undefined;

  state.setPending(pending);
  state.setPendingRemoveInterceptor(removeInterceptor);

  t.is(state.getPending()?.removeInterceptor, removeInterceptor);
});

test('abortPending() moves pending to aborted and clears pending', (t) => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' },
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
  };

  state.setPending(pending);
  state.abortPending();

  t.is(state.getPending(), null);

  const aborted = state.consumeAborted();
  t.truthy(aborted);
  t.is(aborted?.state, pending.state);
  t.is(aborted?.interruption, pending.interruption);
  t.deepEqual(aborted?.emittedCommandIds, pending.emittedCommandIds);
  t.deepEqual(aborted?.toolCallArgumentsById, pending.toolCallArgumentsById);
});

test('consumeAborted() returns aborted context and clears it', (t) => {
  const state = new ApprovalState();
  const pending = {
    state: { id: 'state' },
    interruption: { name: 'tool' },
    emittedCommandIds: new Set(['cmd-1']),
    toolCallArgumentsById: new Map([['call-1', { foo: 'bar' }]]),
  };

  state.setPending(pending);
  state.abortPending();

  const aborted = state.consumeAborted();
  t.truthy(aborted);
  t.is(state.consumeAborted(), null);
});
