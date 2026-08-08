import { it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { RewindTargetId } from '../conversation/conversation-store.js';

it('getCurrentSnapshot reads previousResponseId from persisted state, not a state accessor', () => {
  const state = {
    exportPersistedState: () => ({
      history: [],
      previousResponseId: 'resp-1',
      toolLedger: [],
    }),
    resetSession: () => undefined,
    afterUndo: () => undefined,
    pendingModeNotice: null,
  };

  const manager = new SessionManager({
    conversationStore: {
      getHistory: () => [],
      removeLastUserTurn: () => null,
      removeNLastUserTurns: () => null,
      listUserTurns: () => [],
      addShellContext: () => undefined,
    },
    toolTracker: {
      export: () => [],
    },
    state,
    conversationLogger: {
      log: () => undefined,
    },
    agentClient: {},
    inputPlanner: {
      previewLargeUncachedInput: () => ({ kind: 'pass' }),
    },
  } as any);

  const snapshot = manager.getCurrentSnapshot();
  expect(snapshot.previousResponseId).toBe('resp-1');
});

it('rewindToTarget performs lifecycle cleanup and logging exactly once after a successful domain rewind', () => {
  const rewindToTarget = vi.fn(() => ({ text: 'first', imageCount: 0, discardedTurns: 2 }));
  const afterUndo = vi.fn();
  const log = vi.fn();
  const manager = new SessionManager({
    conversationStore: { rewindToTarget, getHistory: () => [] },
    toolTracker: { export: () => [] },
    state: {
      afterUndo,
      exportPersistedState: () => ({ history: [], previousResponseId: null, toolLedger: [] }),
    },
    conversationLogger: { log },
    agentClient: {},
    inputPlanner: {},
  } as any);

  expect(manager.rewindToTarget('target-1' as RewindTargetId)).toEqual({ text: 'first' });
  expect(afterUndo).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: 'undo', removedUserTurns: 2 }));
});

it('rewindToTarget leaves lifecycle and logs untouched when the target is stale or unknown', () => {
  const rewindToTarget = vi.fn(() => null);
  const afterUndo = vi.fn();
  const log = vi.fn();
  const manager = new SessionManager({
    conversationStore: { rewindToTarget },
    toolTracker: {},
    state: { afterUndo },
    conversationLogger: { log },
    agentClient: {},
    inputPlanner: {},
  } as any);

  expect(manager.rewindToTarget('stale' as RewindTargetId)).toBeNull();
  expect(afterUndo).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});
