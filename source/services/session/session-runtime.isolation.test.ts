import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSessionRuntime } from '../../core/index.js';
import { ExecutionContext } from '../execution-context.js';
import { normalizeToolPath } from '../agent-runtime/scope-resolver.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ISessionContextService, SessionTrafficContext } from '../service-interfaces.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  createMockAgentClient,
  createMockSettingsService,
  mockLogger,
  sessionContextService,
} from './test-helpers/conversation-session-fixtures.js';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const contextServiceFor = (tag: string): ISessionContextService & { contexts: unknown[] } => {
  const contexts: unknown[] = [];
  return {
    contexts,
    runWithContext<T>(context: SessionTrafficContext, fn: () => T): T {
      contexts.push({ tag, context });
      return fn();
    },
    getContext: () => null,
  };
};

const loggerFor = (tag: string) => {
  const events: unknown[] = [];
  return {
    events,
    logger: {
      ...mockLogger,
      info: (message: string) => events.push({ tag, level: 'info', message }),
      warn: (message: string) => events.push({ tag, level: 'warn', message }),
      error: (message: string) => events.push({ tag, level: 'error', message }),
      debug: (message: string) => events.push({ tag, level: 'debug', message }),
    },
  };
};

const makeClient = (tag: string, root: string, steerCalls: unknown[]) => {
  const stream = new MockStream([{ type: 'text_delta', text: tag }]);
  stream.finalOutput = tag;
  stream.lastResponseId = `response-${tag}`;
  return createMockAgentClient({
    executionContext: ExecutionContext.pin(root),
    getProvider: () => `provider-${tag}`,
    startStream: async () => stream,
    steer: async (items: unknown, options: unknown) => {
      steerCalls.push({ tag, items, options });
      return 'released';
    },
  }) as ConversationAgentClient & { executionContext: ExecutionContext };
};

const approvalStream = (callId: string): MockStream => {
  const stream = new MockStream([]);
  stream.interruptions = [
    {
      name: 'shell',
      callId,
      agent: { name: 'test-agent' },
      arguments: JSON.stringify({ command: 'echo approval' }),
    },
  ];
  stream.state = { approve: () => undefined, reject: () => undefined };
  return stream;
};

it('keeps injected runtime state, context, provider continuity, queues, sinks, and registries separate', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'term2-isolation-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'term2-isolation-b-'));
  const contextA = contextServiceFor('a');
  const contextB = contextServiceFor('b');
  const loggerA = loggerFor('a');
  const loggerB = loggerFor('b');
  const steerCalls: unknown[] = [];
  const clientA = makeClient('a', rootA, steerCalls);
  const clientB = makeClient('b', rootB, steerCalls);
  const runtimeA = createSessionRuntime({
    sessionId: 'isolation-a',
    agentClient: clientA,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: {
      logger: loggerA.logger,
      settingsService: createMockSettingsService([
        ['agent.provider', 'provider-a'],
        ['agent.model', 'model-a'],
      ]),
      sessionContextService: contextA,
    },
  });
  const runtimeB = createSessionRuntime({
    sessionId: 'isolation-b',
    agentClient: clientB,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: {
      logger: loggerB.logger,
      settingsService: createMockSettingsService([
        ['agent.provider', 'provider-b'],
        ['agent.model', 'model-b'],
      ]),
      sessionContextService: contextB,
    },
  });

  try {
    const [eventsA, eventsB] = await Promise.all([
      collect(runtimeA.turns.start('turn-a')),
      collect(runtimeB.turns.start('turn-b')),
    ]);
    expect(eventsA.at(-1)).toMatchObject({ type: 'final', finalText: 'a' });
    expect(eventsB.at(-1)).toMatchObject({ type: 'final', finalText: 'b' });
    expect(runtimeA.state.getCurrentSnapshot().history).not.toEqual(runtimeB.state.getCurrentSnapshot().history);
    expect(runtimeA.state.getCurrentSnapshot().provider).toBe('provider-a');
    expect(runtimeB.state.getCurrentSnapshot().provider).toBe('provider-b');
    expect(runtimeA.state.getCurrentSnapshot().previousResponseId).toBe('response-a');
    expect(runtimeB.state.getCurrentSnapshot().previousResponseId).toBe('response-b');
    expect(clientA.executionContext.getCwd()).toBe(rootA);
    expect(clientB.executionContext.getCwd()).toBe(rootB);
    expect(runtimeA.backgroundSubagentNotifications).not.toBe(runtimeB.backgroundSubagentNotifications);
    expect(runtimeA.backgroundTaskControl).not.toBe(runtimeB.backgroundTaskControl);

    const sinkA: unknown[] = [];
    const sinkB: unknown[] = [];
    runtimeA.logs.setLogSink((event) => sinkA.push(event));
    runtimeB.logs.setLogSink((event) => sinkB.push(event));
    runtimeA.logs.log({ type: 'undo', removedUserTurns: 0, snapshot: runtimeA.state.getCurrentSnapshot() });
    runtimeB.logs.log({ type: 'undo', removedUserTurns: 0, snapshot: runtimeB.state.getCurrentSnapshot() });
    expect(sinkA).toHaveLength(1);
    expect(sinkB).toHaveLength(1);
    expect((sinkA[0] as { snapshot: { provider?: string } }).snapshot.provider).toBe('provider-a');
    expect((sinkB[0] as { snapshot: { provider?: string } }).snapshot.provider).toBe('provider-b');

    await Promise.all([
      runtimeA.turns.steer([{ role: 'user', content: 'a-steer' }] as never, { id: 'steer-a' }),
      runtimeB.turns.steer([{ role: 'user', content: 'b-steer' }] as never, { id: 'steer-b' }),
    ]);
    expect(steerCalls).toEqual([
      expect.objectContaining({ tag: 'a', options: { id: 'steer-a' } }),
      expect.objectContaining({ tag: 'b', options: { id: 'steer-b' } }),
    ]);
    expect(contextA.contexts.every((entry) => (entry as { tag: string }).tag === 'a')).toBe(true);
    expect(contextB.contexts.every((entry) => (entry as { tag: string }).tag === 'b')).toBe(true);
  } finally {
    await runtimeA.shutdown();
    await runtimeB.shutdown();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

it('keeps approval ownership and continuation state isolated between concurrent runtimes', async () => {
  const runtimeA = createSessionRuntime({
    sessionId: 'approval-isolation-a',
    agentClient: createMockAgentClient({
      startStream: async () => approvalStream('approval-a'),
      continueRunStream: async () => {
        const stream = new MockStream([{ type: 'text_delta', text: 'a-done' }]);
        stream.finalOutput = 'a-done';
        return stream;
      },
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: loggerFor('approval-a').logger, sessionContextService: contextServiceFor('a') },
  });
  const runtimeB = createSessionRuntime({
    sessionId: 'approval-isolation-b',
    agentClient: createMockAgentClient({
      startStream: async () => approvalStream('approval-b'),
      continueRunStream: async () => {
        const stream = new MockStream([{ type: 'text_delta', text: 'b-done' }]);
        stream.finalOutput = 'b-done';
        return stream;
      },
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: loggerFor('approval-b').logger, sessionContextService: contextServiceFor('b') },
  });

  try {
    await Promise.all([collect(runtimeA.turns.start('a')), collect(runtimeB.turns.start('b'))]);
    expect(runtimeA.approval.getPending()).toMatchObject({ interruption: { callId: 'approval-a' } });
    expect(runtimeB.approval.getPending()).toMatchObject({ interruption: { callId: 'approval-b' } });
    await Promise.all([
      collect(runtimeA.turns.continueAfterApproval({ answer: 'y' })),
      collect(runtimeB.turns.continueAfterApproval({ answer: 'y' })),
    ]);
    expect(runtimeA.approval.getPending()).toBeNull();
    expect(runtimeB.approval.getPending()).toBeNull();
  } finally {
    await runtimeA.shutdown();
    await runtimeB.shutdown();
  }
});

it('fails closed when a second runtime tries to publish a workspace root', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'term2-workspace-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'term2-workspace-b-'));
  const contextA = new ExecutionContext();
  const contextB = new ExecutionContext();
  const runtimeA = createSessionRuntime({
    sessionId: 'workspace-a',
    agentClient: createMockAgentClient({ executionContext: contextA }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });
  contextA.enterWorkspace(rootA);
  const observationBefore = normalizeToolPath('marker.txt');
  const runtimeB = createSessionRuntime({
    sessionId: 'workspace-b',
    agentClient: createMockAgentClient({ executionContext: contextB }),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  try {
    expect(observationBefore).toBe(join(rootA, 'marker.txt'));
    expect(() => contextB.enterWorkspace(rootB)).toThrow('multiple session runtimes are live');
    // The fail-closed writer leaves session A's omitted-baseDir observation on
    // root A rather than allowing root B to retarget it.
    expect(normalizeToolPath('marker.txt')).toBe(join(rootA, 'marker.txt'));
  } finally {
    await runtimeB.shutdown();
    contextA.exitWorkspace();
    await runtimeA.shutdown();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
