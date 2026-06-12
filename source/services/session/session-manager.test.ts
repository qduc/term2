import test from 'ava';
import { SessionManager } from './session-manager.js';

test('getCurrentSnapshot reads previousResponseId from persisted state, not a state accessor', (t) => {
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
  t.is(snapshot.previousResponseId, 'resp-1');
});
