import { it, expect } from 'vitest';
import { ConversationAdapter } from './conversation-adapter.js';
import type { SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { SessionManager } from '../session/session-manager.js';
import type { FinalTerminal } from '../../contracts/conversation.js';

const noop = () => {};

const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
};

const sessionContextService = {
  runWithContext: (_context: any, fn: () => any) => fn(),
  getContext: () => null,
};

it('ConversationAdapter delegates turn execution through an explicit turnFlow dependency', async () => {
  const calls: Array<{ method: string; input?: any; options?: any }> = [];
  const turnFlow = {
    async *start(input: string | UserTurn, options?: any) {
      calls.push({ method: 'start', input, options });
      yield { type: 'final' as const, finalText: 'started' };
    },
    async *continueAfterApproval(options: any) {
      calls.push({ method: 'continueAfterApproval', options });
      yield { type: 'final' as const, finalText: 'continued' };
    },
  };
  const approval = {
    getPending: () => ({ interruption: {}, token: 1 }),
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const userTurns = {
    listUserTurns: () => [],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
  });

  const initial = await adapter.sendMessage('hello');
  const continued = await adapter.handleApprovalDecision('y');

  expect((initial as FinalTerminal).finalText).toBe('started');
  expect((continued as FinalTerminal | null)?.finalText).toBe('continued');
  expect(calls).toEqual([
    {
      method: 'start',
      input: 'hello',
      options: { retries: { hallucinationRetryCount: 0 } },
    },
    {
      method: 'continueAfterApproval',
      options: { answer: 'y', rejectionReason: undefined },
    },
  ]);
});

it('ConversationAdapter forwards streamed events to a persistent event sink', async () => {
  const emitted: any[] = [];
  const turnFlow = {
    async *start() {
      yield { type: 'text_delta' as const, delta: 'Hello' };
      yield { type: 'final' as const, finalText: 'Hello' };
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'continued' };
    },
  };
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const userTurns = {
    listUserTurns: () => [],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
  });

  adapter.setEventSink((event) => emitted.push(event));

  const result = await adapter.sendMessage('hello');

  expect(result.type).toBe('response');
  expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'final']);
});

it('ConversationAdapter fires queuedTurnStartObserver when the queue starts a turn', async () => {
  const turnFlow = {
    async *start() {
      yield { type: 'final' as const, finalText: 'done' };
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const userTurns = {
    listUserTurns: () => [],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
    queueForeground: true,
  });

  const startCalls: Array<{ requestId: string; input: string | UserTurn }> = [];
  adapter.setQueuedTurnStartObserver((execution) => {
    startCalls.push(execution);
  });

  await adapter.sendMessage('queued-1');
  await adapter.sendMessage('queued-2');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  expect(startCalls.length).toBeGreaterThanOrEqual(1);
  expect(startCalls[0]?.input).toBe('queued-1');
});

it('removeLastQueuedItem returns null when there is no queue', async () => {
  const turnFlow = {
    async *start() {
      yield { type: 'final' as const, finalText: 'done' };
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const userTurns = {
    listUserTurns: () => [],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  // No queueForeground here so the adapter has no queue.
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
  });

  expect(await adapter.removeLastQueuedItem()).toBeNull();
});

it('removeLastQueuedItem returns the text of the most recently queued item', async () => {
  const turnFlow = {
    async *start() {
      // Never resolves so the queued items stay in the queue and don't fire.
      await new Promise(() => {});
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const userTurns = {
    listUserTurns: () => [],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
    queueForeground: true,
  });

  void adapter.sendMessage('first');
  void adapter.sendMessage('second');
  // Yield so the submissions land in the queue before we cancel.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const restored = await adapter.removeLastQueuedItem();
  expect(restored).toEqual({ text: 'second' });
});

it('ConversationAdapter populates firstUserMessagePreview in session context', async () => {
  let capturedContext: any = null;
  const sessionContextService = {
    runWithContext: (context: any, fn: () => any) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => null,
  };
  const turnFlow = {
    async *start() {
      yield { type: 'final' as const, finalText: 'done' };
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const userTurns = {
    listUserTurns: () => [{ index: 0, text: 'First message\nwith newline', imageCount: 0 }],
  } as unknown as Pick<SessionManager, 'listUserTurns'>;
  const logs = {
    dispatchEventToLog: noop,
    log: noop,
    setLogSink: noop,
  } as unknown as SessionLogs;
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({}),
  } as unknown as SessionApprovalQuery;

  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
  });

  await adapter.sendMessage('ignore me');

  expect(capturedContext).toMatchObject({
    sessionId: 'session-1',
    firstUserMessagePreview: 'First message with newline',
  });
});
