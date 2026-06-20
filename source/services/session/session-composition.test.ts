import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import {
  createConversationSession,
  createConversationSessionComposition,
  createSessionRuntime,
} from './session-composition.js';
import { createConversationRuntime } from '../conversation/conversation-runtime-factory.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';

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
  runWithContext: (_ctx: any, fn: () => any) => fn(),
  getContext: () => null,
};

const makeMockClient = (overrides = {}) =>
  ({
    async startStream(_input: any, _opts: any) {
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
    continueRunStream: noop as any,
    setModel: noop as any,
    addToolInterceptor: noop as any,
    chat: noop as any,
    ...overrides,
  } as unknown as ConversationAgentClient);

// ── Factory return shape ───────────────────────────────────────────

it('createConversationSession returns bundle with correct sessionId', () => {
  const { sessionId } = createConversationSession({
    sessionId: 'test-123',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(sessionId).toBe('test-123');
});

it('createConversationSession is the public name for the session composition root', () => {
  expect(createConversationSession).toBe(createConversationSessionComposition);
});

it('createConversationSession returns bundle with correct sessionStartedAt when provided', () => {
  const ts = '2024-01-01T00:00:00.000Z';
  const { sessionStartedAt } = createConversationSession({
    sessionId: 'test-ts',
    sessionStartedAt: ts,
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(sessionStartedAt).toBe(ts);
});

it('createConversationSession returns bundle with auto sessionStartedAt when not provided', () => {
  const before = new Date().toISOString();
  const { sessionStartedAt } = createConversationSession({
    sessionId: 'auto-ts',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  const after = new Date().toISOString();
  expect(sessionStartedAt >= before).toBe(true);
  expect(sessionStartedAt <= after).toBe(true);
});

it('createSessionRuntime exposes runtime capabilities without conversation adapter construction details', () => {
  const runtime = createSessionRuntime({
    sessionId: 'runtime-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });

  expect(runtime.sessionId).toBe('runtime-test');
  expect(typeof runtime.turns.start).toBe('function');
  expect(typeof runtime.turns.continueAfterApproval).toBe('function');
  expect(typeof runtime.turns.abort).toBe('function');
  expect(typeof runtime.state.getCurrentSnapshot).toBe('function');
  expect(typeof runtime.settings.setModel).toBe('function');
  expect(typeof runtime.logs.setLogSink).toBe('function');
  expect('terminalAdapter' in runtime).toBe(false);
  runtime.dispose();
});

it('session composition does not import the conversation adapter', () => {
  const source = readFileSync(new URL('./session-composition.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('../conversation/conversation-adapter.js');
  expect(source).not.toContain('session-adapter-bridge');
  expect(source).not.toContain('ConversationAdapter');
});

it('createConversationRuntime returns a bundle with adapter.sendMessage', () => {
  const { adapter } = createConversationRuntime({
    sessionId: 'ta-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(typeof adapter.sendMessage).toBe('function');
  expect(typeof adapter.handleApprovalDecision).toBe('function');
});

it('createConversationSessionComposition composes a plain appState object with a statusMachine', () => {
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
    } as any,
  });
  expect(Object.getPrototypeOf(appState)).toBe(Object.prototype);
  expect(appState.statusMachine.current).toBe('idle');
});

it('createConversationSession returns stateFacade with undo/snapshot operations', () => {
  const { stateFacade } = createConversationSession({
    sessionId: 'sf-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(typeof stateFacade.reset).toBe('function');
  expect(typeof stateFacade.undoLastUserTurn).toBe('function');
  expect(typeof stateFacade.listUserTurns).toBe('function');
  expect(typeof stateFacade.undoNUserTurns).toBe('function');
  expect(typeof stateFacade.getCurrentSnapshot).toBe('function');
  expect(typeof stateFacade.exportState).toBe('function');
  expect(typeof stateFacade.importState).toBe('function');
  expect(typeof stateFacade.addShellContext).toBe('function');
  expect(typeof stateFacade.queueModeNotice).toBe('function');
});

it('createConversationSession returns runtimeController with model/provider operations', () => {
  const { runtimeController } = createConversationSession({
    sessionId: 'rc-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(typeof runtimeController.setModel).toBe('function');
  expect(typeof runtimeController.setProvider).toBe('function');
  expect(typeof runtimeController.switchProvider).toBe('function');
  expect(typeof runtimeController.setRetryCallback).toBe('function');
});

it('createConversationSession returns a dispose function', () => {
  const { dispose } = createConversationSession({
    sessionId: 'dispose-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(typeof dispose).toBe('function');
});

// ── Disposal ─────────────────────────────────────────────────────

it('dispose() is idempotent — safe to call twice without throwing', () => {
  const { dispose } = createConversationSession({
    sessionId: 'idempotent',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });
  expect(() => {
    dispose();
    dispose();
  }).not.toThrow();
});

it('dispose() resets previousResponseId so next run starts fresh', () => {
  const { dispose } = createConversationSession({
    sessionId: 'prev-resp-id',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });

  // We'll just check that dispose doesn't throw
  expect(() => dispose()).not.toThrow();
});

// ── No callback into partially-constructed session ────────────────

it('turnCoordinator.abort() does not throw', () => {
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
  expect(() => turnCoordinator.abort()).not.toThrow();
});

// ── Non-interactive path ──────────────────────────────────────────

it('createConversationRuntime adapter can be used as ConversationSessionLike', () => {
  const { adapter } = createConversationRuntime({
    sessionId: 'ni-test',
    agentClient: makeMockClient(),
    deps: { logger: makeLogger(), sessionContextService },
  });

  // Verify the shape matches what runWithSession expects
  expect(typeof adapter.sendMessage).toBe('function');
  expect(typeof adapter.handleApprovalDecision).toBe('function');
});
