/* eslint-disable require-yield */
import { it, expect, vi } from 'vitest';
import { ConversationAdapter } from './conversation-adapter.js';
import { QueueController } from '../queue/queue-controller.js';
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

it('delivers a steer into the running turn instead of queueing it', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const started: string[] = [];
  const steered: unknown[][] = [];
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
      steer: async (items) => {
        steered.push([...items]);
        return 'admitted' as const;
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));

  await expect(adapter.steerActiveTurn('change direction')).resolves.toBe(true);

  // The steer joins the running turn: no second turn is started for it.
  expect(started).toEqual(['active']);
  expect(steered).toHaveLength(1);
  const item = steered[0]![0] as { type: string; role: string; content: string };
  expect(item).toMatchObject({ type: 'message', role: 'user' });
  expect(item.content).toContain('change direction');

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('injects pre-built items into the running turn without a steering preamble', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const steered: unknown[][] = [];
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
        if (text === 'active') await activeReleased;
        yield { type: 'final' as const, finalText: text };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async (items) => {
        steered.push([...items]);
        return 'admitted' as const;
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));

  await expect(
    adapter.injectIntoActiveTurn([{ type: 'message', role: 'user', content: 'shell session output' }]),
  ).resolves.toBe(true);

  // A system-spoken injection carries its own words only: the steering notice
  // would misattribute it to the user.
  const item = steered[0]![0] as { content: string };
  expect(item.content).toBe('shell session output');

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('reports an injection as undeliverable when no turn is running', async () => {
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => 'admitted' as const,
    },
    queueForeground: true,
  });

  await expect(
    adapter.injectIntoActiveTurn([{ type: 'message', role: 'user', content: 'shell session output' }]),
  ).resolves.toBe(false);
});

it('reports a steer as undeliverable when no turn is running', async () => {
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => 'admitted' as const,
    },
    queueForeground: true,
  });

  await expect(adapter.steerActiveTurn('nothing to steer')).resolves.toBe(false);
});

it('runs an undeliverable steer as its own turn, ahead of earlier follow-ups', async () => {
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
      // The running turn cannot take it: it has no request boundary left.
      steer: async () => 'released' as const,
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active');
  await new Promise((resolve) => setImmediate(resolve));
  const followUp = adapter.sendMessage('follow-up');
  await new Promise((resolve) => setImmediate(resolve));

  expect(await adapter.steerActiveTurn('late steer')).toBe(false);
  const steer = adapter.sendMessage('late steer', { busyMode: 'steer' });

  // Nothing is cancelled: the active turn runs to its own end first.
  expect(started).toEqual(['active']);
  releaseActive();

  await expect(active).resolves.toMatchObject({ type: 'response' });
  await expect(steer).resolves.toMatchObject({ type: 'response', finalText: 'late steer' });
  await expect(followUp).resolves.toMatchObject({ type: 'response', finalText: 'follow-up' });
  expect(started).toEqual(['active', 'late steer', 'follow-up']);
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

// ── retractSubmission / editSubmission ──────────────────────────────────

it('editSubmission on a queued item sends the edited text — the #messagesById write edit_queued alone misses', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const started: Array<string | UserTurn> = [];
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
        started.push(input);
        if (started.length === 1) await activeReleased;
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = adapter.sendMessage('original text', { preferredMessageId: 'queued-1' });
  await new Promise((resolve) => setImmediate(resolve));

  const mutation = await adapter.editSubmission('queued-1', { text: 'edited text' });
  expect(mutation).toEqual({ kind: 'applied', stage: 'queued' });

  // Asserting only queue.state() would still pass against an implementation
  // that redraws the edit in the controller's display text but leaves the
  // #messagesById entry — and therefore the turn that actually runs — on the
  // original input. Assert on what the turn that eventually runs receives.
  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
  await expect(queued).resolves.toMatchObject({ type: 'response' });

  expect(started).toHaveLength(2);
  expect(started[0]).toBe('active');
  expect(started[1]).toMatchObject({ text: 'edited text' });
});

it('editSubmission on a queued item rolls back #messagesById when the controller rejects the edit (hazard 2)', async () => {
  // editSubmission writes the edited turn into #messagesById before it knows
  // whether edit_queued will be accepted. If the controller rejects — the
  // item started running during the await — the pre-edit write must not
  // stick, or the running turn (which reads #messagesById at its own start)
  // sends the edited text while the caller is simultaneously told too_late
  // and, per '## Losing the race', resubmits that same text as a fresh
  // message: sent twice. Force the rejection deterministically (rather than
  // depending on winning a real timing race) by making the controller refuse
  // this one edit_queued call, and assert the turn that actually executes
  // still received the *original* input.
  const originalCommand = QueueController.prototype.command;
  const commandSpy = vi
    .spyOn(QueueController.prototype, 'command')
    .mockImplementation(function (this: unknown, cmd: any) {
      if (cmd.kind === 'edit_queued' && cmd.itemId === 'queued-1') {
        return Promise.resolve({ kind: 'rejected', reason: 'not_queued' });
      }
      return originalCommand.call(this as InstanceType<typeof QueueController>, cmd);
    });

  try {
    let releaseActive!: () => void;
    const activeReleased = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const started: Array<string | UserTurn> = [];
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
          started.push(input);
          if (started.length === 1) await activeReleased;
          yield { type: 'final' as const, finalText: 'done' };
        },
        async *continueAfterApproval() {
          yield { type: 'final' as const, finalText: 'done' };
        },
      },
      queueForeground: true,
    });

    const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
    await new Promise((resolve) => setImmediate(resolve));
    const queued = adapter.sendMessage('original text', { preferredMessageId: 'queued-1' });
    await new Promise((resolve) => setImmediate(resolve));

    const mutation = await adapter.editSubmission('queued-1', { text: 'edited text' });
    expect(mutation).toEqual({ kind: 'too_late', stage: 'started' });

    releaseActive();
    await expect(active).resolves.toMatchObject({ type: 'response' });
    await expect(queued).resolves.toMatchObject({ type: 'response' });
    expect(started).toHaveLength(2);
    expect(started[0]).toBe('active');
    // Without the rollback this would read 'edited text' — the write that
    // should have been undone when the controller reported too_late.
    expect(started[1]).toBe('original text');
  } finally {
    commandSpy.mockRestore();
  }
});

it('retractSubmission removes a queued item by id and settles its sendMessage promise', async () => {
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
      async *start(input: string | UserTurn) {
        const text = typeof input === 'string' ? input : input.text;
        started.push(text);
        if (started.length === 1) await activeReleased;
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = adapter.sendMessage('to be retracted', { preferredMessageId: 'queued-1' });
  await new Promise((resolve) => setImmediate(resolve));

  const mutation = await adapter.retractSubmission('queued-1');
  expect(mutation).toEqual({ kind: 'applied', stage: 'queued' });
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
  expect(started).toEqual(['active']);
});

it('retractSubmission and editSubmission report unknown_id for an id the adapter has never seen', async () => {
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  await expect(adapter.retractSubmission('never-existed')).resolves.toEqual({ kind: 'unknown_id' });
  await expect(adapter.editSubmission('never-existed', { text: 'x' })).resolves.toEqual({ kind: 'unknown_id' });
});

it('retractSubmission and editSubmission report too_late for the item currently executing', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));

  await expect(adapter.retractSubmission('active')).resolves.toEqual({ kind: 'too_late', stage: 'started' });
  await expect(adapter.editSubmission('active', { text: 'too late' })).resolves.toEqual({
    kind: 'too_late',
    stage: 'started',
  });

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('routes retractSubmission to a still-pending steer via retractSteer', async () => {
  let resolveSteer!: (outcome: 'admitted' | 'released' | 'retracted') => void;
  const steerPromise = new Promise<'admitted' | 'released' | 'retracted'>((resolve) => {
    resolveSteer = resolve;
  });
  const retractedIds: string[] = [];
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => steerPromise,
      retractSteer: (id: string) => {
        retractedIds.push(id);
        resolveSteer('retracted');
        return true;
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));

  const steered = adapter.steerActiveTurn('change direction', { id: 'steer-1' });
  await new Promise((resolve) => setImmediate(resolve));

  const mutation = await adapter.retractSubmission('steer-1');
  expect(mutation).toEqual({ kind: 'applied', stage: 'pending_steer' });
  expect(retractedIds).toEqual(['steer-1']);
  // The run loop's own resolution is what unwinds the caller waiting on the
  // original steerActiveTurn call.
  await expect(steered).resolves.toBe(false);

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('routes editSubmission to a still-pending steer via editSteer', async () => {
  let resolveSteer!: (outcome: 'admitted' | 'released' | 'retracted') => void;
  const steerPromise = new Promise<'admitted' | 'released' | 'retracted'>((resolve) => {
    resolveSteer = resolve;
  });
  const editCalls: Array<{ id: string; content: unknown }> = [];
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => steerPromise,
      editSteer: (id, items) => {
        editCalls.push({ id, content: (items[0] as { content?: unknown } | undefined)?.content });
        return true;
      },
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));

  const steered = adapter.steerActiveTurn('original', { id: 'steer-1' });
  await new Promise((resolve) => setImmediate(resolve));

  const mutation = await adapter.editSubmission('steer-1', { text: 'edited' });
  expect(mutation).toEqual({ kind: 'applied', stage: 'pending_steer' });
  expect(editCalls).toHaveLength(1);
  expect(editCalls[0]!.id).toBe('steer-1');
  expect(String(editCalls[0]!.content)).toContain('edited');

  resolveSteer('admitted');
  await expect(steered).resolves.toBe(true);

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('retractSubmission reports too_late for a pending steer the run loop already admitted', async () => {
  // The steer promise never settles in this test: it stands in for the run
  // loop having already admitted the item — retractSteer reports it the same
  // way — while the adapter's own #pendingSteerIds bookkeeping has not yet
  // observed that settlement (`## Losing the race`).
  const steerPromise = new Promise<'admitted' | 'released' | 'retracted'>(() => {});
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => steerPromise,
      retractSteer: () => false,
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));

  void adapter.steerActiveTurn('change direction', { id: 'steer-1' }).catch(noop);
  await new Promise((resolve) => setImmediate(resolve));

  await expect(adapter.retractSubmission('steer-1')).resolves.toEqual({ kind: 'too_late', stage: 'started' });

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('retractSubmission throws rather than reporting too_late when turnFlow.steer is wired but turnFlow.retractSteer is not (hazard 3)', async () => {
  // retractSteer/editSteer are optional on TurnFlow only so a turnFlow that
  // implements steer alone still type-checks. But #pendingSteerIds is only
  // ever populated by a call that required turnFlow.steer to exist, so
  // whichever caller wired steer must also wire retractSteer. An id landing
  // here with the method missing is a wiring bug, not "the run loop already
  // admitted it" -- collapsing the two into the same too_late outcome would
  // tell the user "already sent" about a submission the run loop never had
  // a chance to admit or refuse.
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => new Promise(() => {}),
      // retractSteer intentionally left unwired.
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  void adapter.steerActiveTurn('change direction', { id: 'steer-1' }).catch(noop);
  await new Promise((resolve) => setImmediate(resolve));

  await expect(adapter.retractSubmission('steer-1')).rejects.toThrow(/retractSteer/);

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});

it('editSubmission throws rather than reporting too_late when turnFlow.steer is wired but turnFlow.editSteer is not (hazard 3)', async () => {
  let releaseActive!: () => void;
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
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
        yield { type: 'final' as const, finalText: 'done' };
      },
      async *continueAfterApproval() {
        yield { type: 'final' as const, finalText: 'done' };
      },
      steer: async () => new Promise(() => {}),
      // editSteer intentionally left unwired.
    },
    queueForeground: true,
  });

  const active = adapter.sendMessage('active', { preferredMessageId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  void adapter.steerActiveTurn('change direction', { id: 'steer-1' }).catch(noop);
  await new Promise((resolve) => setImmediate(resolve));

  await expect(adapter.editSubmission('steer-1', { text: 'edited' })).rejects.toThrow(/editSteer/);

  releaseActive();
  await expect(active).resolves.toMatchObject({ type: 'response' });
});
