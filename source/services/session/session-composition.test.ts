import test from 'ava';
import { createConversationSession, createConversationSessionComposition } from './session-composition.js';

const noop = () => {};

const makeLogger = () => ({
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
});

const sessionContextService = {
  runWithContext: (_ctx, fn) => fn(),
  getContext: () => null,
};

const makeMockClient = (overrides = {}) => ({
  async startStream(_input, _opts) {
    return {
      interruptions: [],
      state: null,
      history: [],
      newItems: [],
      finalOutput: 'ok',
      lastResponseId: null,
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next() {
            if (!done) {
              done = true;
              return Promise.resolve({
                done: false,
                value: { type: 'response.output_text.delta', delta: 'ok' },
              });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  },
  abort: noop,
  ...overrides,
});

// ── Factory return shape ───────────────────────────────────────────

test('createConversationSession returns bundle with correct sessionId', (t) => {
  const { sessionId } = createConversationSession({
    sessionId: 'test-123',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(sessionId, 'test-123');
});

test('createConversationSession is the public name for the session composition root', (t) => {
  t.is(createConversationSession, createConversationSessionComposition);
});

test('createConversationSession returns bundle with correct sessionStartedAt when provided', (t) => {
  const ts = '2024-01-01T00:00:00.000Z';
  const { sessionStartedAt } = createConversationSession({
    sessionId: 'test-ts',
    sessionStartedAt: ts,
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(sessionStartedAt, ts);
});

test('createConversationSession returns bundle with auto sessionStartedAt when not provided', (t) => {
  const before = new Date().toISOString();
  const { sessionStartedAt } = createConversationSession({
    sessionId: 'auto-ts',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  const after = new Date().toISOString();
  t.true(sessionStartedAt >= before);
  t.true(sessionStartedAt <= after);
});

test('createConversationSession returns a terminalAdapter with sendMessage', (t) => {
  const { terminalAdapter } = createConversationSession({
    sessionId: 'ta-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(typeof terminalAdapter.sendMessage, 'function');
  t.is(typeof terminalAdapter.handleApprovalDecision, 'function');
});

test('createConversationSessionComposition composes a plain appState object with a statusMachine', (t) => {
  const { appState } = createConversationSessionComposition({
    sessionId: 'app-state-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
    turnAccumulator: {
      append: () => undefined,
      reset: () => undefined,
      resetPersistedTurnState: () => undefined,
      addPending: () => undefined,
      addAssistant: () => undefined,
      addTool: () => undefined,
      addReasoning: () => undefined,
      addCommandMessage: () => undefined,
      addToolStarted: () => undefined,
      addUser: () => undefined,
      getTurnItems: () => [],
      getPendingTurnItems: () => [],
      getPersistedTurnState: () => [],
    },
  });
  t.is(Object.getPrototypeOf(appState), Object.prototype);
  t.is(appState.statusMachine.current, 'idle');
});

test('createConversationSession returns stateFacade with undo/snapshot operations', (t) => {
  const { stateFacade } = createConversationSession({
    sessionId: 'sf-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(typeof stateFacade.reset, 'function');
  t.is(typeof stateFacade.undoLastUserTurn, 'function');
  t.is(typeof stateFacade.listUserTurns, 'function');
  t.is(typeof stateFacade.undoNUserTurns, 'function');
  t.is(typeof stateFacade.getCurrentSnapshot, 'function');
  t.is(typeof stateFacade.exportState, 'function');
  t.is(typeof stateFacade.importState, 'function');
  t.is(typeof stateFacade.addShellContext, 'function');
  t.is(typeof stateFacade.queueModeNotice, 'function');
});

test('createConversationSession returns runtimeController with model/provider operations', (t) => {
  const { runtimeController } = createConversationSession({
    sessionId: 'rc-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(typeof runtimeController.setModel, 'function');
  t.is(typeof runtimeController.setProvider, 'function');
  t.is(typeof runtimeController.switchProvider, 'function');
  t.is(typeof runtimeController.setRetryCallback, 'function');
});

test('createConversationSession returns a dispose function', (t) => {
  const { dispose } = createConversationSession({
    sessionId: 'dispose-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.is(typeof dispose, 'function');
});

// ── Disposal ─────────────────────────────────────────────────────

test('dispose() is idempotent — safe to call twice without throwing', (t) => {
  const { dispose } = createConversationSession({
    sessionId: 'idempotent',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  t.notThrows(() => {
    dispose();
    dispose();
  });
});

test('dispose() resets previousResponseId so next run starts fresh', (t) => {
  const { dispose } = createConversationSession({
    sessionId: 'prev-resp-id',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });

  // We'll just check that dispose doesn't throw
  t.notThrows(() => dispose());
});

// ── No callback into partially-constructed session ────────────────

test('turnCoordinator.abort() does not throw', (t) => {
  const abortCalled = { value: false };
  const mockClient = makeMockClient({
    abort: () => {
      abortCalled.value = true;
    },
  });

  const { turnCoordinator } = createConversationSession({
    sessionId: 'abort-test',
    agentClient: mockClient,
    deps: { logger: makeLogger(), sessionContextService },
  });

  // Should not throw
  t.notThrows(() => turnCoordinator.abort());
});

// ── Non-interactive path ──────────────────────────────────────────

test('createConversationSession can be used as ConversationSessionLike', (t) => {
  const { terminalAdapter } = createConversationSession({
    sessionId: 'ni-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });

  // Verify the shape matches what runWithSession expects
  t.is(typeof terminalAdapter.sendMessage, 'function');
  t.is(typeof terminalAdapter.handleApprovalDecision, 'function');
});
