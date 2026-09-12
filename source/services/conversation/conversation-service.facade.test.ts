import { it, expect, vi } from 'vitest';
import { ConversationService } from './conversation-service.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ConversationEvent } from './conversation-events.js';
import type { SessionClientFactory, SessionClientHandle } from '../session/session-client-factory.js';
import { createAgentStream } from '../agent-stream.js';
import { MockStream, createMockStream } from '../test-helpers/mock-stream.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import { createOwnedSessionClientFactory } from '../session/session-client-factory.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: (): string | undefined => undefined,
  clearCorrelationId: () => {},
};

const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T): T => fn(),
  getContext: () => null,
};

function partialClient(methods: Record<string, unknown> = {}): ConversationAgentClient {
  return {
    chat: async () => '',
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => createMockStream([]),
    continueRunStream: async () => createMockStream([]),
    ...methods,
  } as ConversationAgentClient;
}

function completedStream(text: string): MockStream {
  const stream = new MockStream([{ type: 'text_delta', text }]);
  stream.finalOutput = text;
  return stream;
}

class GatedStream {
  interruptions: unknown[] = [];
  state = {};
  newItems: unknown[] = [];
  history: unknown[] = [];
  finalOutput = '';
  completed = Promise.resolve();
  readonly #gate: Promise<void>;

  constructor(gate: Promise<void>) {
    this.#gate = gate;
    createAgentStream(this as never);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    await this.#gate;
    return;
  }
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function factoryForClients(
  clients: ConversationAgentClient[],
  configureHandle?: (client: ConversationAgentClient, sessionId: string) => Partial<SessionClientHandle>,
): SessionClientFactory {
  let index = 0;
  return {
    create(sessionId) {
      const client = clients[index++];
      if (!client) throw new Error('test factory ran out of clients');
      return {
        agentClient: client,
        continuationProjectionMode: 'legacy',
        toolOwnership: new ToolOwnershipRegistry(),
        dispose: () => {},
        ...configureHandle?.(client, sessionId),
      };
    },
  };
}

it('throws when neither sessionClientFactory nor agentClient is provided', () => {
  expect(
    () =>
      new ConversationService({
        deps: { logger: mockLogger, sessionContextService },
      }),
  ).toThrowError(new Error('ConversationService requires an agentClient or sessionClientFactory'));
});

it('throws when a caller-owned agentClient is provided without toolOwnership', () => {
  expect(
    () =>
      new ConversationService({
        agentClient: partialClient(),
        deps: { logger: mockLogger, sessionContextService },
      }),
  ).toThrowError(new Error('ConversationService requires toolOwnership with an agentClient'));
});

it('logs a session rollover marker at the public conversation boundary', () => {
  const client = partialClient({ consumeSessionRolloverRequest: () => ({ status: 'none' }) });
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  const events: unknown[] = [];
  service.setLogSink((event) => events.push(event));

  service.logSessionRollover({
    type: 'session_rollover',
    phase: 'requested',
    rolloverId: 'rollover-1',
    sourceSessionId: 'default',
    reason: 'context_pressure',
    briefSize: 32,
    providerInputTokens: 210_000,
  });

  expect(events).toEqual([
    {
      type: 'session_rollover',
      phase: 'requested',
      rolloverId: 'rollover-1',
      sourceSessionId: 'default',
      reason: 'context_pressure',
      briefSize: 32,
      providerInputTokens: 210_000,
    },
  ]);
});

it('rollover keeps the caller-owned client alive while replacing root identity', () => {
  const client = partialClient();
  const abort = vi.spyOn(client, 'abort');
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    sessionId: 'before-rollover',
    deps: { logger: mockLogger, sessionContextService },
  });

  service.rolloverWithNewId('after-rollover');

  expect(service.sessionId).toBe('after-rollover');
  expect(abort).not.toHaveBeenCalled();
  service.dispose();
});

it('keeps the owned client identity aligned when rollover follows ordinary clear', () => {
  const ownedFactory = createOwnedSessionClientFactory(
    { get: () => undefined, getDynamic: () => undefined } as any,
    () => partialClient(),
  );
  const handles: SessionClientHandle[] = [];
  const service = new ConversationService({
    sessionClientFactory: {
      create(id, options) {
        const handle = ownedFactory.create(id, options);
        handles.push(handle);
        return handle;
      },
    },
    sessionId: 'original',
    deps: { logger: mockLogger, sessionContextService },
  });
  try {
    service.resetWithNewId('cleared');
    service.rolloverWithNewId('successor');
    expect(service.sessionId).toBe('successor');
    expect(handles.at(-1)?.sessionIdentity?.current).toBe('successor');
  } finally {
    service.dispose();
  }
});

it('prepares rollover admission before returning a commit callback', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    sessionId: 'before-rollover',
    deps: { logger: mockLogger, sessionContextService },
  });

  const commit = service.prepareRolloverWithNewId('after-rollover', '2026-09-06T11:00:00.000Z');
  expect(service.sessionId).toBe('before-rollover');
  commit();
  expect(service.sessionId).toBe('after-rollover');
  service.dispose();
});

it('retains owned background shell output and notification wiring across rollover', async () => {
  let registry: any;
  let output: any;
  const providerCalls: Array<{ text: string; options: any }> = [];
  let backgroundSink: ((event: ConversationEvent) => void) | null = null;
  const settings = {
    get: (key: string) => (key === 'agent.provider' ? 'openai' : undefined),
    getDynamic: () => undefined,
  } as any;
  const factory = createOwnedSessionClientFactory(settings, (...args: any[]) => {
    registry = args[8];
    output = args[10];
    return partialClient({
      startStream: async (text: string, options: any) => {
        providerCalls.push({ text, options });
        return completedStream('successor response');
      },
      setBackgroundShellEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
        backgroundSink = sink;
      },
    });
  });
  const service = new ConversationService({
    sessionClientFactory: factory,
    sessionId: 'owned-before',
    deps: { logger: mockLogger, sessionContextService },
  });
  const job = registry.launch({
    command: 'hold',
    run: (signal: AbortSignal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }),
      ),
  });
  output.store.open(job.id);
  output.store.push(job.id, 'stdout', 'retained output\n');

  service.importState({
    history: [{ type: 'message', role: 'user', content: 'predecessor context' }],
    previousResponseId: 'predecessor-response',
    toolLedger: [],
  });
  service.rolloverWithNewId('owned-after', '2026-09-06T11:00:00.000Z');
  await service.sendMessage('successor request');

  expect(registry.get(job.id)).toEqual(expect.objectContaining({ id: job.id, status: 'running' }));
  expect(output.store.readTail(job.id, 100)?.text).toBe('retained output\n');
  expect(providerCalls[0]).toMatchObject({
    text: 'successor request',
    options: {
      sessionId: 'owned-after',
      previousResponseId: null,
      providerHistorySnapshot: expect.objectContaining({
        history: [{ type: 'message', role: 'user', content: 'successor request' }],
      }),
    },
  });
  expect(backgroundSink).toEqual(expect.any(Function));
  const retainedBackgroundSink = backgroundSink as unknown as (event: ConversationEvent) => void;
  retainedBackgroundSink({
    type: 'background_check_in_due',
    target: { kind: 'shell', id: job.id },
    checkInIndex: 1,
    elapsedMs: 1_000,
    details: { kind: 'shell', id: job.id, command: 'hold' },
  });
  expect(service.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ kind: 'check_in', target: { kind: 'shell', id: job.id } }),
  ]);
  service.dispose();
});

it('does not let a stale interaction projection block a settled session rollover', () => {
  const request = {
    reason: 'task_boundary' as const,
    brief: 'Continue.',
    rolloverId: 'rollover-1',
    requestedAt: 1,
  };
  const client = partialClient({
    consumeSessionRolloverRequest: () => ({ status: 'ready' as const, request }),
  });
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.presentPendingInteraction({
    agentName: 'CLI Agent',
    toolName: 'shell',
    argumentsText: '{}',
    rawInterruption: {},
  });

  expect(service.consumeSessionRolloverRequest()).toEqual({
    status: 'ready',
    request,
  });
});

it('blocks a settled session rollover while a standalone check-in interaction is pending', () => {
  const request = {
    reason: 'task_boundary' as const,
    brief: 'Continue.',
    rolloverId: 'rollover-2',
    requestedAt: Date.now(),
  };
  const client = partialClient({
    consumeSessionRolloverRequest: () => ({ status: 'ready' as const, request }),
  });
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  const events: unknown[] = [];
  service.setLogSink((event) => events.push(event));
  service.presentPendingInteraction({
    agentName: 'System',
    toolName: 'check_in',
    argumentsText: 'Continue?',
    rawInterruption: null,
    checkIn: 'max_turns',
  });

  expect(service.consumeSessionRolloverRequest()).toEqual({
    status: 'blocked',
    blocker: 'pending_interaction',
    error: 'Session rollover was not performed because a user interaction or queued submission is pending.',
    request,
  });
  expect(events).toEqual([
    expect.objectContaining({
      type: 'session_rollover',
      phase: 'blocked',
      rolloverId: 'rollover-2',
      sourceSessionId: 'default',
      reason: 'task_boundary',
      briefSize: 9,
      blocker: 'pending_interaction',
      settlementLatencyMs: expect.any(Number),
    }),
  ]);
});

it('leaves the root state unchanged when direct rollover admission is blocked', () => {
  const client = partialClient();
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    sessionId: 'before-rollover',
    deps: { logger: mockLogger, sessionContextService },
  });
  service.presentPendingInteraction({
    agentName: 'System',
    toolName: 'check_in',
    argumentsText: 'Continue?',
    rawInterruption: null,
    checkIn: 'max_turns',
  });

  expect(() => service.rolloverWithNewId('after-rollover')).toThrow(
    'Session rollover is blocked while a user interaction or approval is pending.',
  );
  expect(service.sessionId).toBe('before-rollover');
  expect(service.getPendingInteractionSnapshot()?.approval.checkIn).toBe('max_turns');
  service.dispose();
});

it('constructs with a caller-owned agentClient and toolOwnership', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    sessionId: 'caller-owned',
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  expect(service.sessionId).toBe('caller-owned');
  expect(() => service.dispose()).not.toThrow();
});

it('grantRunBudgetExtension returns a denied grant when the client cannot grant', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  expect(service.grantRunBudgetExtension()).toEqual({ granted: false, extensionsGranted: 0 });
  service.dispose();
});

it('grantRunBudgetExtension forwards the client grant', () => {
  const service = new ConversationService({
    agentClient: partialClient({
      grantRunBudgetExtension: () => ({ granted: true, extensionsGranted: 1 }),
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  expect(service.grantRunBudgetExtension()).toEqual({ granted: true, extensionsGranted: 1 });
  service.dispose();
});

it('hookEvents is absent on a caller-owned compatibility client', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  expect(service.hookEvents).toBeUndefined();
  service.dispose();
});

it('exposes the factory-owned HookEventFactory', () => {
  const client = partialClient();
  let createdHookEvents: HookEventFactory | undefined;
  const service = new ConversationService({
    sessionClientFactory: factoryForClients([client], (_client, sessionId) => {
      createdHookEvents = new HookEventFactory({ sessionId });
      return { hookEvents: createdHookEvents };
    }),
    deps: { logger: mockLogger, sessionContextService },
  });

  expect(service.hookEvents).toBe(createdHookEvents);
  service.dispose();
});

it('addShellContext stores shell history when no turn is running', async () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  service.addShellContext('shell output from history');
  await flushQueue();

  expect(service.exportState().history).toEqual([
    { role: 'user', type: 'message', content: 'shell output from history' },
  ]);
  service.dispose();
});

it('addShellContext injects into an active turn instead of adding a fallback history row', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const steered: unknown[] = [];
  let streamCalls = 0;
  const client = partialClient({
    async startStream() {
      streamCalls++;
      return new GatedStream(gate);
    },
    async steer(items: readonly unknown[]) {
      steered.push(...items);
      return 'admitted';
    },
  });
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  const active = service.sendMessage('active turn');
  await flushQueue();
  expect(streamCalls).toBe(1);

  service.addShellContext('shell output during turn');
  await flushQueue();

  expect(steered).toEqual([{ type: 'message', role: 'user', content: 'shell output during turn' }]);
  expect(service.exportState().history).toEqual([{ role: 'user', type: 'message', content: 'active turn' }]);

  release();
  await active;
  service.dispose();
});

it('addShellContext ignores blank history text', async () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  const before = service.exportState();
  service.addShellContext('  \n\t  ');
  await flushQueue();

  expect(service.exportState()).toEqual(before);
  service.dispose();
});

it('compactContext reports busy with no compaction frames while a turn is running', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: ConversationEvent[] = [];
  const service = new ConversationService({
    agentClient: partialClient({ startStream: async () => new GatedStream(gate) }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });

  const active = service.sendMessage('busy turn');
  await flushQueue();
  await expect(service.compactContext()).resolves.toBe(
    'Context compaction is available only while the conversation is idle.',
  );
  // Pre-start refusal (contract 13 §8 frame invariant): the compaction never
  // began, so no frame is published and nothing_to_compact is the response.
  expect(events.map((event) => event.type)).toEqual([]);

  release();
  await active;
  service.dispose();
});

it('compactContext reports nothing to compact with no frames when no complete cold turn exists', async () => {
  const events: ConversationEvent[] = [];
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });

  await expect(service.compactContext()).resolves.toBe(
    'Nothing to compact: at least one complete cold turn is required.',
  );
  // Pre-start refusal (contract 13 §8 frame invariant): the runtime decides
  // no_complete_cold_turn before committing to compact, so neither the started
  // frame nor a terminal frame is published (regression pin for the D3b class:
  // the response must not disagree with the event stream).
  expect(events.map((event) => event.type)).toEqual([]);
  service.dispose();
});

it('compactContextDetailed reports failed/native_unavailable when the codex native compaction is unavailable', async () => {
  const events: ConversationEvent[] = [];
  const warn = vi.spyOn(mockLogger, 'warn').mockImplementation(() => {});
  const service = new ConversationService({
    agentClient: partialClient({
      getProvider: () => 'codex',
      compactCodexSessionHistory: async () => ({ kind: 'unchanged' }),
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });

  // Codex 'unchanged' (the model's native compactHistory hook is missing) is a
  // started compaction that did not compact: it fails with its own typed
  // reason instead of reading as nothing_to_compact.
  await expect(service.compactContextDetailed()).resolves.toEqual({
    kind: 'failed',
    message: 'Native context compaction is unavailable for this model.',
    reason: 'native_unavailable',
  });

  expect(events.map((event) => event.type)).toEqual(['context_compaction_started', 'context_compaction_failed']);
  expect(events[1]).toMatchObject({ errorCategory: 'request', strategy: 'local' });
  expect(warn).toHaveBeenCalledWith(
    'Manual context compaction failed',
    expect.objectContaining({ eventType: 'context_compaction.failed', reason: 'native_unavailable' }),
  );
  warn.mockRestore();
  service.dispose();
});

it('compactContextDetailed reports failed/native_failed when the codex native compaction fails', async () => {
  const events: ConversationEvent[] = [];
  const warn = vi.spyOn(mockLogger, 'warn').mockImplementation(() => {});
  const service = new ConversationService({
    agentClient: partialClient({
      getProvider: () => 'codex',
      compactCodexSessionHistory: async () => ({ kind: 'failed', provider: 'codex' }),
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });

  // The typed outcome, and the display message the CLI's /compact shows.
  await expect(service.compactContextDetailed()).resolves.toEqual({
    kind: 'failed',
    message: 'Native context compaction failed.',
    reason: 'native_failed',
  });
  await expect(service.compactContext()).resolves.toBe('Native context compaction failed.');

  // The failure is a provider-request failure, journaled as such, and leaves a
  // log line with the typed reason. Both invocations (typed + string) journal
  // the same started -> failed pair.
  expect(events.map((event) => event.type)).toEqual([
    'context_compaction_started',
    'context_compaction_failed',
    'context_compaction_started',
    'context_compaction_failed',
  ]);
  expect(events[1]).toMatchObject({ errorCategory: 'request', strategy: 'local' });
  expect(events[3]).toMatchObject({ errorCategory: 'request', strategy: 'local' });
  expect(warn).toHaveBeenCalledWith(
    'Manual context compaction failed',
    expect.objectContaining({ eventType: 'context_compaction.failed', reason: 'native_failed' }),
  );
  warn.mockRestore();
  service.dispose();
});

it('queues a user message submitted while local compaction is running', async () => {
  let releaseSummary!: (value: string) => void;
  const chat = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        releaseSummary = resolve;
      }),
  );
  const startedTurns: string[] = [];
  const service = new ConversationService({
    agentClient: partialClient({
      chat,
      startStream: async (input: unknown) => {
        startedTurns.push(typeof input === 'string' ? input : JSON.stringify(input));
        return completedStream('after compact');
      },
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.importState({
    history: Array.from({ length: 4 }, (_, index) => [
      { role: 'user', type: 'message', content: `user-${index}` },
      { role: 'assistant', type: 'message', content: `assistant-${index}` },
    ]).flat(),
    previousResponseId: null,
    toolLedger: [],
  });

  const compacting = service.compactContext();
  await vi.waitFor(() => expect(chat).toHaveBeenCalled());
  expect(service.isQueueOwningSubmissions()).toBe(true);

  const followUp = service.sendMessage('after compact');
  await flushQueue();
  expect(startedTurns).toEqual([]);

  releaseSummary('deterministic summary');
  await expect(compacting).resolves.toMatch(/^Context compacted locally \(/);
  await followUp;
  expect(startedTurns.length).toBeGreaterThan(0);
  service.dispose();
});

it('abort during compaction cancels it and releases the foreground queue', async () => {
  const chat = vi.fn(
    () =>
      new Promise<string>(() => {
        /* hang until abort */
      }),
  );
  const service = new ConversationService({
    agentClient: partialClient({ chat }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.importState({
    history: Array.from({ length: 4 }, (_, index) => [
      { role: 'user', type: 'message', content: `user-${index}` },
      { role: 'assistant', type: 'message', content: `assistant-${index}` },
    ]).flat(),
    previousResponseId: null,
    toolLedger: [],
  });

  const compacting = service.compactContext();
  await vi.waitFor(() => expect(chat).toHaveBeenCalled());
  expect(service.isQueueOwningSubmissions()).toBe(true);

  service.abort();
  await expect(compacting).resolves.toBe('Context compaction cancelled.');
  expect(service.isQueueOwningSubmissions()).toBe(false);
  service.dispose();
});

it('compactContext emits completion events for deterministic local compaction', async () => {
  const events: ConversationEvent[] = [];
  const service = new ConversationService({
    agentClient: partialClient({ chat: async () => 'deterministic summary' }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });
  service.importState({
    history: Array.from({ length: 4 }, (_, index) => [
      { role: 'user', type: 'message', content: `user-${index}` },
      { role: 'assistant', type: 'message', content: `assistant-${index}` },
    ]).flat(),
    previousResponseId: null,
    toolLedger: [],
  });

  await expect(service.compactContext()).resolves.toMatch(/^Context compacted locally \(/);
  expect(events.map((event) => event.type)).toEqual(['context_compaction_started', 'context_compaction_completed']);
  expect(events[1]).toMatchObject({ strategy: 'local' });
  service.dispose();
});

it('re-primes Plan Mode notice after resetWithNewId when planMode is on', async () => {
  const streamInputs: unknown[] = [];
  const clients = [
    partialClient(),
    partialClient({
      startStream: async (input: unknown) => {
        streamInputs.push(input);
        return completedStream('after reset');
      },
    }),
  ];
  const service = new ConversationService({
    sessionClientFactory: factoryForClients(clients),
    deps: {
      logger: mockLogger,
      sessionContextService,
      settingsService: {
        get: (key: string) =>
          key === 'app.activeProfileId' ? 'builtin:plan' : key === 'app.planMode' ? true : undefined,
      } as any,
    },
  });

  service.resetWithNewId('replacement');
  await service.sendMessage('post-reset plan');

  expect(JSON.stringify(streamInputs)).toContain('post-reset plan');
  expect(JSON.stringify(streamInputs)).toContain('Plan Mode Workflow');
  service.dispose();
});

it('keeps the event sink attached when the session is reset', async () => {
  const clients = [partialClient(), partialClient({ startStream: async () => completedStream('after reset') })];
  const events: ConversationEvent[] = [];
  const service = new ConversationService({
    sessionClientFactory: factoryForClients(clients),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setEventSink((event) => {
    events.push(event);
  });

  service.resetWithNewId('replacement');
  await service.sendMessage('post-reset');

  expect(events.some((event) => event.type === 'text_delta')).toBe(true);
  service.dispose();
});

it('keeps the log sink attached when the session is reset', () => {
  const service = new ConversationService({
    sessionClientFactory: factoryForClients([partialClient(), partialClient()]),
    deps: { logger: mockLogger, sessionContextService },
  });
  const logs: unknown[] = [];
  service.setLogSink((event) => logs.push(event));
  service.resetWithNewId('replacement');
  service.importState({
    history: [
      { role: 'user', type: 'message', content: 'first' },
      { role: 'assistant', type: 'message', content: 'first answer' },
      { role: 'user', type: 'message', content: 'second' },
      { role: 'assistant', type: 'message', content: 'second answer' },
    ],
    previousResponseId: null,
    toolLedger: [],
  });

  const target = service.listRewindTargets()[0];
  expect(target).toBeDefined();
  service.rewindToTarget(target!.id);

  expect(logs).toContainEqual(expect.objectContaining({ type: 'undo' }));
  service.dispose();
});

it('keeps background notification and task observers attached when the session is reset', async () => {
  const backgroundSinks: Array<((event: ConversationEvent) => void) | null> = [];
  const clients = [0, 1].map((index) =>
    partialClient({
      setSubagentEventSink: () => {},
      setBackgroundSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => {
        backgroundSinks[index] = sink;
      },
    }),
  );
  const service = new ConversationService({
    sessionClientFactory: factoryForClients(clients),
    deps: { logger: mockLogger, sessionContextService },
  });
  let notificationObserverCalls = 0;
  let taskObserverCalls = 0;
  service.setBackgroundSubagentNotificationObserver(() => notificationObserverCalls++);
  service.setBackgroundSubagentTaskObserver(() => taskObserverCalls++);

  service.resetWithNewId('replacement');
  await Promise.resolve();

  expect(typeof backgroundSinks[1]).toBe('function');
  backgroundSinks[1]?.({
    type: 'subagent_started',
    agentId: 'run-reset',
    role: 'worker',
    task: 'post-reset task',
    parentTool: 'run_subagent_async',
    async: true,
  });
  backgroundSinks[1]?.({
    type: 'subagent_completed',
    async: true,
    result: {
      agentId: 'run-reset',
      role: 'worker',
      status: 'completed',
      finalText: 'post-reset result',
      filesChanged: [],
      toolsUsed: [],
    },
  });

  expect(taskObserverCalls).toBeGreaterThan(0);
  expect(notificationObserverCalls).toBe(1);
  expect(service.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({ runId: 'run-reset', status: 'completed' }),
  ]);
  expect(service.backgroundSubagentNotifications.drain()).toEqual([
    expect.objectContaining({ kind: 'completion', runId: 'run-reset' }),
  ]);
  service.dispose();
});

it('keeps queue observers attached when the session is reset', async () => {
  const queueStates: Array<{ stateKind: string }> = [];
  const queuedStarts: Array<{ input: string | { text: string } }> = [];
  const initialClient = partialClient({
    startStream: async () => {
      throw new Error('the pre-reset client must not run the post-reset message');
    },
  });
  const replacementClient = partialClient({
    startStream: async () => completedStream('post-reset response'),
  });
  const service = new ConversationService({
    sessionClientFactory: factoryForClients([initialClient, replacementClient]),
    deps: { logger: mockLogger, sessionContextService },
  });
  service.setQueueStateObserver((snapshot) => queueStates.push(snapshot));
  service.setQueuedTurnStartObserver((execution) => queuedStarts.push({ input: execution.input as string }));
  const beforeReset = queueStates.length;

  service.resetWithNewId('replacement');
  await service.sendMessage('post-reset input');

  expect(queueStates.length).toBeGreaterThan(beforeReset);
  expect(queuedStarts).toHaveLength(1);
  expect(queuedStarts[0]?.input).toBe('post-reset input');
  service.dispose();
});

it('keeps the retry callback attached when the session is reset', () => {
  const callbacks: Array<(() => void) | undefined> = [];
  const clients = [0, 1].map((index) =>
    partialClient({
      setRetryCallback: (callback: () => void) => {
        callbacks[index] = callback;
      },
    }),
  );
  const service = new ConversationService({
    sessionClientFactory: factoryForClients(clients),
    deps: { logger: mockLogger, sessionContextService },
  });
  let calls = 0;
  const callback = () => calls++;

  service.setRetryCallback(callback);
  expect(callbacks[0]).toBe(callback);
  service.resetWithNewId('replacement');

  expect(callbacks[1]).toBeTypeOf('function');
  callbacks[1]!();
  expect(calls).toBe(1);
  service.dispose();
});

it('does not expose session runtime fields on the conversation service', () => {
  const service = new ConversationService({
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  for (const field of [
    'turns',
    'state',
    'settings',
    'sinks',
    'approval',
    'logs',
    'sessionStartedAt',
    'generationGuard',
    'conversationStore',
  ]) {
    expect(field in service).toBe(false);
  }
  service.dispose();
});
