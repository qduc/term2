import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './session-manager.js';

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
