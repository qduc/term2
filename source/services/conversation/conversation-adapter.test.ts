/* eslint-disable require-yield */
import { it, expect } from 'vitest';
import { ConversationAdapter } from './conversation-adapter.js';
import type { SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { SessionManager } from '../session/session-manager.js';
import type { FinalTerminal } from '../../contracts/conversation.js';
import type { ConversationEvent } from './conversation-events.js';

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

it('sendMessage rejects when the turn event stream exhausts without a terminal event', async () => {
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: 'now',
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => null } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start() {
        yield { type: 'text_delta' as const, delta: 'stale partial text' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'unused' };
      },
    },
  });

  await expect(adapter.sendMessage('run')).rejects.toMatchObject({
    name: 'AmbiguousModelOutcomeError',
    unsafeToReplay: true,
  });
});

const postExecuteApprovalEvent = (revision: number, id: string) => ({
  type: 'approval_required' as const,
  approval: {
    agentName: 'Agent',
    toolName: 'shell',
    argumentsText: '{}',
    postExecute: { kind: 'post_execute' as const, sessionId: 'session-1', epoch: 'epoch-1', revision, ids: [id] },
  },
});

it('routes typed post-execute approvals through the registry before resuming the retained live run', async () => {
  let revision = 1;
  let ids = ['gate-1'];
  const calls: string[] = [];
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => ({ sdk: 'must not be used' }),
    getPostExecutePending: () => ({
      sessionId: 'session-1',
      epoch: 'epoch-1',
      revision,
      entries: ids.map((id) => ({ id })),
      closed: false,
    }),
    decidePostExecutePending: ({ revision: requested, ids: selected, decision }: any) => {
      calls.push(`settle:${decision}:${selected.join(',')}`);
      if (requested !== revision || selected.some((id: string) => !ids.includes(id))) return { kind: 'invalid' };
      ids = ids.filter((id) => !selected.includes(id));
      revision++;
      return { kind: 'settled' };
    },
  } as unknown as SessionApprovalQuery;
  const turnFlow = {
    async *start() {
      yield postExecuteApprovalEvent(1, 'gate-1');
    },
    async *continueAfterApproval() {
      calls.push('sdk-continuation');
      yield { type: 'final' as const, finalText: 'wrong' };
    },
    async *continueAfterPostExecuteApproval() {
      calls.push(`post-continuation:${ids.join(',')}`);
      if (calls.filter((call) => call.startsWith('post-continuation')).length === 1) {
        ids = ['gate-2'];
        revision++;
        yield postExecuteApprovalEvent(revision, 'gate-2');
        return;
      }
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: 'now',
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval,
    turnFlow,
  });

  expect((await adapter.sendMessage('run')).type).toBe('approval_required');
  expect((await adapter.handleApprovalDecision('y'))?.type).toBe('approval_required');
  expect(await adapter.handleApprovalDecision('n')).toMatchObject({ type: 'response', finalText: 'done' });
  expect(calls).toEqual(['settle:approve:gate-1', 'post-continuation:', 'settle:reject:gate-2', 'post-continuation:']);
  expect(calls).not.toContain('sdk-continuation');
});

it('does not settle a typed post-execute token whose session or epoch no longer matches', async () => {
  let settled = false;
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => null,
    getPostExecutePending: () => ({
      sessionId: 'replacement',
      epoch: 'epoch-2',
      revision: 1,
      entries: [{ id: 'gate-1' }],
      closed: false,
    }),
    decidePostExecutePending: () => {
      settled = true;
      return { kind: 'settled' };
    },
  } as unknown as SessionApprovalQuery;
  const turnFlow = {
    async *start() {
      yield postExecuteApprovalEvent(1, 'gate-1');
    },
    async *continueAfterApproval() {
      throw new Error('SDK continuation must not run');
    },
    async *continueAfterPostExecuteApproval() {
      throw new Error('post-execute continuation must not run');
    },
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: 'now',
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval,
    turnFlow,
  });

  await adapter.sendMessage('run');
  await expect(adapter.handleApprovalDecision('y')).resolves.toBeNull();
  expect(settled).toBe(false);
});

it('does not continue when a typed post-execute token revision is stale', async () => {
  let decisionCalls = 0;
  const approval = {
    getPending: () => null,
    getPendingInterruption: () => null,
    getPostExecutePending: () => ({
      sessionId: 'session-1',
      epoch: 'epoch-1',
      revision: 2,
      entries: [{ id: 'gate-1' }],
      closed: false,
    }),
    decidePostExecutePending: () => {
      decisionCalls++;
      return { kind: 'invalid', reason: 'revision_mismatch' };
    },
  } as unknown as SessionApprovalQuery;
  const turnFlow = {
    async *start() {
      yield postExecuteApprovalEvent(1, 'gate-1');
    },
    async *continueAfterApproval() {
      throw new Error('SDK continuation must not run');
    },
    async *continueAfterPostExecuteApproval() {
      throw new Error('post-execute continuation must not run');
    },
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: 'now',
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval,
    turnFlow,
  });

  await adapter.sendMessage('run');
  await expect(adapter.handleApprovalDecision('y')).resolves.toBeNull();
  expect(decisionCalls).toBe(1);
});

it('does not apply a delayed approval decision to a replacement pending approval', async () => {
  let pending: any = null;
  let releaseApprovalCommand!: () => void;
  const approvalCommandCanFinish = new Promise<void>((resolve) => {
    releaseApprovalCommand = resolve;
  });
  let approvalCommandStarted!: () => void;
  const approvalCommandIsDelayed = new Promise<void>((resolve) => {
    approvalCommandStarted = resolve;
  });
  let delayNextRunningPersist = false;
  const continuedTokens: number[] = [];
  const approval = {
    getPending: () => pending,
    getPendingInterruption: () => pending?.interruption ?? null,
  } as unknown as SessionApprovalQuery;
  const turnFlow = {
    async *start(input: string | UserTurn) {
      const token = input === 'A' ? 1 : 2;
      pending = { token, interruption: { callId: `call-${token}` } };
      yield {
        type: 'approval_required' as const,
        approval: { agentName: 'Agent', toolName: 'shell', argumentsText: '{}', callId: `call-${token}` },
      };
    },
    async *continueAfterApproval() {
      continuedTokens.push(pending.token);
      yield { type: 'final' as const, finalText: 'continued' };
    },
    abort() {
      pending = null;
    },
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: 'now',
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval,
    turnFlow,
    queueForeground: true,
    queuePersistence: {
      load: () => null,
      async replace(record: any) {
        if (delayNextRunningPersist && record.active?.phase === 'running') {
          delayNextRunningPersist = false;
          approvalCommandStarted();
          await approvalCommandCanFinish;
        }
      },
    },
  });

  expect((await adapter.sendMessage('A')).type).toBe('approval_required');
  delayNextRunningPersist = true;
  const delayedDecision = adapter.handleApprovalDecision('y');
  await approvalCommandIsDelayed;

  adapter.abort();
  const replacement = adapter.sendMessage('B');
  await new Promise((resolve) => setImmediate(resolve));
  releaseApprovalCommand();
  expect((await replacement).type).toBe('approval_required');

  await expect(delayedDecision).resolves.toBeNull();
  expect(continuedTokens).toEqual([]);
  expect(pending.token).toBe(2);
});

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

it('ConversationAdapter marks system-initiated queue turns so the UI does not render them as user messages', async () => {
  const turnFlow = {
    async *start() {
      yield { type: 'final' as const, finalText: 'done' };
    },
    async *continueAfterApproval() {
      yield { type: 'final' as const, finalText: 'done' };
    },
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow,
    queueForeground: true,
  });

  const startCalls: Array<{ suppressUserMessageDisplay?: boolean }> = [];
  adapter.setQueuedTurnStartObserver((execution) => {
    startCalls.push(execution);
  });

  await adapter.sendMessage('automatic notification', { suppressUserMessageDisplay: true });

  expect(startCalls).toContainEqual(expect.objectContaining({ suppressUserMessageDisplay: true }));
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

  void adapter.sendMessage('first').catch(noop);
  void adapter.sendMessage('second').catch(noop);
  // Yield so the submissions land in the queue before we cancel.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const restored = await adapter.removeLastQueuedItem();
  expect(restored).toEqual({ id: '2', text: 'second' });
});

it('settles only the removed queued request and preserves FIFO execution for the others', async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input: string | UserTurn) {
        started.push(typeof input === 'string' ? input : input.text);
        if (started.length === 1) await firstReleased;
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  const first = adapter.sendMessage('A', { preferredMessageId: 'A' });
  const second = adapter.sendMessage('B', { preferredMessageId: 'B' });
  const third = adapter.sendMessage('C', { preferredMessageId: 'C' });
  const removed = await adapter.removeLastQueuedItem();

  expect(removed).toEqual({ id: 'C', text: 'C' });
  await expect(third).rejects.toMatchObject({ name: 'AbortError' });
  releaseFirst();
  await expect(first).resolves.toMatchObject({ type: 'response' });
  await expect(second).resolves.toMatchObject({ type: 'response' });
  expect(started).toEqual(['A', 'B']);
});

it('steers ahead of queued follow-ups and then drains those follow-ups FIFO', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const started: string[] = [];
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input) {
        const text = typeof input === 'string' ? input : input.text;
        started.push(text);
        if (text === 'active') await activeReleased;
        yield { type: 'final' as const, finalText: text };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      stopAfterCurrentTool: () => {},
    },
    queueForeground: true,
    activeCancelTimeoutMs: 100,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));
  const followUp1 = adapter.sendMessage('follow-up-1');
  const followUp2 = adapter.sendMessage('follow-up-2');
  await new Promise((resolve) => setImmediate(resolve));
  const steer = adapter.sendMessage('steer', { busyMode: 'steer' });

  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(started).toEqual(['active']);
  releaseActive();

  await expect(active).resolves.toMatchObject({ type: 'response' });
  await expect(steer).resolves.toMatchObject({ type: 'response', finalText: 'steer' });
  await expect(followUp1).resolves.toMatchObject({ type: 'response', finalText: 'follow-up-1' });
  await expect(followUp2).resolves.toMatchObject({ type: 'response', finalText: 'follow-up-2' });
  expect(started).toEqual(['active', 'steer', 'follow-up-1', 'follow-up-2']);
});

it('keeps a steer queued instead of dropping it when the active turn does not reach a safe boundary', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const started: string[] = [];
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input) {
        const text = typeof input === 'string' ? input : input.text;
        started.push(text);
        if (text === 'active') await activeReleased;
        yield { type: 'final' as const, finalText: text };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      stopAfterCurrentTool: () => {},
    },
    queueForeground: true,
    activeCancelTimeoutMs: 5,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));

  const steer = adapter.sendMessage('steer', { busyMode: 'steer' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(started).toEqual(['active']);

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
  await expect(steer).resolves.toMatchObject({ type: 'response', finalText: 'steer' });
  expect(started).toEqual(['active', 'steer']);
});

it('runs a deferred steer when the active turn stops after the steer stopped waiting', async () => {
  let stopActive!: () => void;
  const activeStopped = new Promise<void>((_resolve, reject) => {
    stopActive = () => reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
  });
  const started: string[] = [];
  let stopRequests = 0;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input) {
        const text = typeof input === 'string' ? input : input.text;
        started.push(text);
        if (text === 'active') await activeStopped;
        yield { type: 'final' as const, finalText: text };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      // A stop that only lands later, well after the steer gave up waiting.
      stopAfterCurrentTool: () => {
        stopRequests += 1;
      },
    },
    queueForeground: true,
    activeCancelTimeoutMs: 5,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));
  const steer = adapter.sendMessage('steer', { busyMode: 'steer' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(stopRequests).toBe(1);
  stopActive();

  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await expect(steer).resolves.toMatchObject({ type: 'response', finalText: 'steer' });
  expect(started).toEqual(['active', 'steer']);
});

it('settles discarded paused requests without settling retained work on cancellation', async () => {
  let abortActive!: () => void;
  const activeAbort = new Promise<void>((resolve) => {
    abortActive = resolve;
  });
  let queueState: string | undefined;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start() {
        await activeAbort;
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      abort: () => abortActive(),
    },
    queueForeground: true,
  });
  adapter.setQueueStateObserver((state) => {
    queueState = state.stateKind;
  });

  const active = adapter.sendMessage('A');
  const retained = adapter.sendMessage('B');
  adapter.abort();
  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(queueState).toBe('paused');

  let retainedSettled = false;
  void retained
    .finally(() => {
      retainedSettled = true;
    })
    .catch(noop);
  await Promise.resolve();
  expect(retainedSettled).toBe(false);
  await adapter.discardQueue();
  await expect(retained).rejects.toMatchObject({ name: 'AbortError' });
});

it('classifies terminal-less exhaustion as cancellation only for the execution being intentionally cancelled', async () => {
  let endActive!: () => void;
  const activeEnded = new Promise<void>((resolve) => {
    endActive = resolve;
  });
  const started: string[] = [];
  let queueState: string | undefined;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input) {
        started.push(String(input));
        if (started.length === 1) {
          await activeEnded;
          return;
        }
        yield { type: 'final' as const, finalText: 'retained terminal' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      abort: () => endActive(),
    },
    queueForeground: true,
  });
  adapter.setQueueStateObserver((state) => {
    queueState = state.stateKind;
  });

  const active = adapter.sendMessage('active');
  const retained = adapter.sendMessage('retained');
  await new Promise((resolve) => setImmediate(resolve));
  adapter.abort();

  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(queueState).toBe('paused');
  expect(started).toEqual(['active']);

  let retainedSettled = false;
  void retained.finally(() => {
    retainedSettled = true;
  });
  await Promise.resolve();
  expect(retainedSettled).toBe(false);

  await adapter.resumeQueue();
  await expect(retained).resolves.toMatchObject({ type: 'response', finalText: 'retained terminal' });
  expect(started).toEqual(['active', 'retained']);
});

it('preserves a genuine stream error that races with intentional cancellation', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const providerError = new Error('provider stream failed during abort');
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start() {
        await activeReleased;
        throw providerError;
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      abort: () => releaseActive(),
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));
  adapter.abort();

  await expect(active).rejects.toBe(providerError);
});

it('force-settles the active request when cancel completes even if the turn ignores abort', async () => {
  let queueState: string | undefined;
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start() {
        // Never settles and ignores abort — cancel must still free the queue.
        await new Promise(() => {});
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      abort: noop,
    },
    queueForeground: true,
    activeCancelTimeoutMs: 20,
  });
  adapter.setQueueStateObserver((state) => {
    queueState = state.stateKind;
  });

  const active = adapter.sendMessage('stuck');
  const retained = adapter.sendMessage('later');
  await new Promise((resolve) => setImmediate(resolve));
  adapter.abort();

  await expect(active).rejects.toMatchObject({ name: 'AbortError' });
  expect(queueState).toBe('paused');

  let retainedSettled = false;
  void retained
    .finally(() => {
      retainedSettled = true;
    })
    .catch(noop);
  await Promise.resolve();
  expect(retainedSettled).toBe(false);
});

it('settles an enqueue rejection without retaining an adapter record', async () => {
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start() {
        yield { type: 'final' as const, finalText: 'unexpected' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
    queueCapacity: 0,
  });

  await expect(adapter.sendMessage('rejected')).rejects.toThrow('Foreground queue rejected message: capacity');
  expect(adapter.isQueueOwningSubmissions()).toBe(false);
});

it('executes a queued rich UserTurn from its in-memory snapshot', async () => {
  const inputs: Array<string | UserTurn> = [];
  const turn: UserTurn = {
    text: '',
    images: [{ id: 'image-1', data: 'data', mimeType: 'image/png', byteSize: 4, displayNumber: 1 }],
  };
  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    logger,
    sessionContextService,
    userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
    logs: { dispatchEventToLog: noop, log: noop, setLogSink: noop } as unknown as SessionLogs,
    approval: { getPending: () => null, getPendingInterruption: () => ({}) } as unknown as SessionApprovalQuery,
    turnFlow: {
      async *start(input: string | UserTurn) {
        inputs.push(input);
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  await adapter.sendMessage(turn);
  expect(inputs).toEqual([turn]);
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

it('ConversationAdapter cancels live async subagent runs when the turn ends', async () => {
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

  const sinkCalls: Array<string | null> = [];
  const cancelCalls: number[] = [];
  const subagentEventSinkHost = {
    setSubagentEventSink(sink: ((event: ConversationEvent) => void) | null) {
      sinkCalls.push(typeof sink);
    },
    cancelSubagentRuns() {
      cancelCalls.push(1);
    },
  };

  const adapter = new ConversationAdapter({
    sessionId: 'session-1',
    startedAt: '2026-06-12T00:00:00.000Z',
    logger,
    sessionContextService,
    userTurns,
    logs,
    approval,
    turnFlow,
    subagentEventSinkHost,
  });

  await adapter.sendMessage('hello');

  expect(sinkCalls).toEqual(['function', 'object']);
  expect(cancelCalls.length).toBe(1);
});
