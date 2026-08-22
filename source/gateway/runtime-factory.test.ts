import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationAgentClient } from '../services/conversation-agent-client.js';
import { createMockStream } from '../services/test-helpers/mock-stream.js';
import { createAgentStream } from '../services/agent-stream.js';
import { RuntimeFactory, RuntimeFactoryError } from './runtime-factory.js';
import type { ProviderBrokerCapability, SessionBinding } from './contracts.js';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(path.join('/tmp', 'term2-runtime-'));
  roots.push(value);
  return value;
};
const broker: ProviderBrokerCapability = {
  capabilityId: 'operator-capability',
  providerId: 'fixture',
  modelId: 'fixture-model',
  request: async () => ({ text: 'ok' }),
  async *stream() {
    yield { type: 'done' as const };
  },
};
const partialClient = (): ConversationAgentClient =>
  ({
    chat: async () => '',
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => createMockStream([]),
    continueRunStream: async () => createMockStream([]),
  } as ConversationAgentClient);
const binding = (canonicalRoot: string, sessionId: string, ownerUserId = 'owner') => ({
  sessionId,
  ownerUserId,
  workspaceId: sessionId,
  grantVersion: 1,
  canonicalRoot,
  access: 'read' as const,
});

const makeFactory = (
  tmpDir: string,
  policy?: { maxQueuedSubmissions?: number; preparedLeaseTtlMs?: number },
  options?: { activeCancelTimeoutMs?: number; createAgentClient?: () => ConversationAgentClient },
) =>
  new RuntimeFactory({
    tmpDir,
    providerBroker: broker,
    providerProbe: { available: true, secretFree: true },
    sandboxAvailable: true,
    policy,
    activeCancelTimeoutMs: options?.activeCancelTimeoutMs,
    createAgentClient: options?.createAgentClient ?? (() => partialClient()),
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parkedStream(): { stream: ReturnType<typeof createAgentStream>; release: () => void } {
  let release!: () => void;
  let released = false;
  const parked = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  const stream = createAgentStream({
    async *[Symbol.asyncIterator]() {
      await parked;
      if (released) yield { type: 'final' as const, finalText: 'done' } as never;
    },
    completed: parked,
    history: [],
    newItems: [],
    output: [],
    lastResponseId: null,
  });
  return { stream, release };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('RuntimeFactory and ServerSession', () => {
  it('creates distinct session object graphs and immutable broker/default snapshots', async () => {
    const tmpDir = root();
    const factory = makeFactory(tmpDir);
    const a = await factory.create(binding(root(), 'session-a'));
    const b = await factory.create(binding(root(), 'session-b'));
    expect(a.resources.executionContext).not.toBe(b.resources.executionContext);
    expect(a.resources.providerBroker).not.toBe(b.resources.providerBroker);
    expect(a.resources.settings).not.toBe(b.resources.settings);
    expect(a.resources.settings).toEqual(expect.objectContaining({ providerId: 'fixture', modelId: 'fixture-model' }));
    expect(a.resources.executionContext.getCwd()).toBe(a.binding.canonicalRoot);
    expect(b.resources.executionContext.getCwd()).toBe(b.binding.canonicalRoot);
    expect(a.resources.settings.executionRoot).toBe(a.resources.executionContext.getCwd());
    expect(b.resources.settings.executionRoot).toBe(b.resources.executionContext.getCwd());
    expect(Object.isFrozen(a.binding)).toBe(true);
    await a.dispose();
    await b.dispose();
    expect(factory.liveSessionCount).toBe(0);
  });

  it('rejects invalid roots and missing limits before composing term2 objects', async () => {
    const factory = makeFactory(root());
    await expect(factory.create(binding('/definitely/missing', 'missing'))).rejects.toThrowError(
      new RuntimeFactoryError('invalid_binding'),
    );
    expect(() => makeFactory(root(), { maxQueuedSubmissions: 33 })).toThrowError(
      new RuntimeFactoryError('resource_limit'),
    );
  });

  it('implements prepare/commit/cancel without starting work during prepare', async () => {
    let starts = 0;
    const factory = new RuntimeFactory({
      tmpDir: root(),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      sandboxAvailable: true,
      createAgentClient: () =>
        ({
          ...partialClient(),
          startStream: async () => {
            starts++;
            return createMockStream([]);
          },
        } as ConversationAgentClient),
    });
    const session = await factory.create(binding(root(), 'admission'));
    const prepared = await session.prepareMessage('hello', { turnId: 'turn-1', clientRequestId: 'request-1' });
    expect(prepared.kind).toBe('prepared');
    expect(starts).toBe(0);
    if (prepared.kind !== 'prepared') throw new Error('test setup');
    await session.cancelPreparedMessage(prepared.leaseId);
    expect(starts).toBe(0);
    const committed = await session.prepareMessage('hello', { turnId: 'turn-2', clientRequestId: 'request-2' });
    if (committed.kind !== 'prepared') throw new Error('test setup');
    await session.commitMessage(committed.leaseId);
    expect(session.status).toBe('running');
    await session.dispose();
  });

  it('reaps expired leases and makes cancellation idempotent', async () => {
    const factory = makeFactory(root(), { maxQueuedSubmissions: 1, preparedLeaseTtlMs: 1 });
    const session = await factory.create(binding(root(), 'lease-reaper'));
    const prepared = await session.prepareMessage('expired', { turnId: 'expired', clientRequestId: 'expired' });
    expect(prepared.kind).toBe('prepared');
    await wait(5);
    const replacement = await session.prepareMessage('replacement', {
      turnId: 'replacement',
      clientRequestId: 'replacement',
    });
    expect(replacement.kind).toBe('prepared');
    if (prepared.kind === 'prepared') {
      await expect(session.cancelPreparedMessage(prepared.leaseId)).rejects.toMatchObject({ code: 'stale' });
    }
    await session.dispose();

    const cancelFactory = makeFactory(root());
    const cancelSession = await cancelFactory.create(binding(root(), 'cancel-idempotent'));
    const cancellable = await cancelSession.prepareMessage('cancel', {
      turnId: 'cancel-turn',
      clientRequestId: 'cancel-request',
    });
    if (cancellable.kind !== 'prepared') throw new Error('test setup');
    await cancelSession.cancelPreparedMessage(cancellable.leaseId);
    await cancelSession.cancelPreparedMessage(cancellable.leaseId);
    await cancelSession.dispose();
  });

  it('rejects duplicate sessions and creation after shutdown', async () => {
    const factory = makeFactory(root());
    const first = await factory.create(binding(root(), 'duplicate'));
    await expect(factory.create(binding(root(), 'duplicate'))).rejects.toMatchObject({ code: 'invalid_binding' });
    await first.dispose();
    await factory.shutdown();
    await expect(factory.create(binding(root(), 'after-shutdown'))).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects duplicate and wrong-session commits while keeping shell and provider limits wired', async () => {
    const captured: { input?: any } = {};
    const factory = new RuntimeFactory({
      tmpDir: root(),
      providerBroker: broker,
      providerProbe: { available: true, secretFree: true },
      sandboxAvailable: true,
      policy: { maxProviderRequestsPerTurn: 1, maxParallelToolCalls: 1 },
      createAgentClient: (input) => {
        captured.input = input;
        return partialClient();
      },
    });
    const a = await factory.create(binding(root(), 'commit-a'));
    const b = await factory.create(binding(root(), 'commit-b'));
    const prepared = await a.prepareMessage('hello', { turnId: 'turn-a', clientRequestId: 'request-a' });
    if (prepared.kind !== 'prepared') throw new Error('test setup');
    await expect(b.commitMessage(prepared.leaseId)).rejects.toMatchObject({ code: 'wrong_turn' });
    await a.commitMessage(prepared.leaseId);
    await expect(a.commitMessage(prepared.leaseId)).rejects.toMatchObject({ code: 'wrong_turn' });
    expect(captured.input).toEqual(
      expect.objectContaining({ gatewayMode: true, allowBackgroundShell: false, maxToolOutputBytes: 1_048_576 }),
    );
    expect(captured.input.env).not.toHaveProperty('API_KEY');
    expect(captured.input.spawnOptions.gatewayMode).toBe(true);
    expect(captured.input.policy.maxProviderRequestsPerTurn).toBe(1);
    expect(captured.input.policy.maxShellJobs).toBe(0);
    await captured.input.providerBroker.request({ messages: [] });
    await expect(captured.input.providerBroker.request({ messages: [] })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    await a.dispose();
    await b.dispose();
  });

  it('reports an unproven hung cancellation as interrupted and keeps admission closed', async () => {
    let starts = 0;
    let aborts = 0;
    let parked: ReturnType<typeof parkedStream> | undefined;
    const factory = makeFactory(root(), undefined, {
      activeCancelTimeoutMs: 5,
      createAgentClient: () =>
        ({
          ...partialClient(),
          abort: () => {
            aborts++;
          },
          startStream: async () => {
            starts++;
            parked = parkedStream();
            return parked.stream;
          },
        } as ConversationAgentClient),
    });
    const session = await factory.create(binding(root(), 'hung'));
    const prepared = await session.prepareMessage('hung', { turnId: 'hung-turn', clientRequestId: 'hung-request' });
    if (prepared.kind !== 'prepared') throw new Error('test setup');
    await session.commitMessage(prepared.leaseId);
    await wait(10);
    expect(starts).toBe(1);
    const outcome = await session.abort('hung-turn');
    expect(outcome).toEqual({ kind: 'interrupted', turnId: 'hung-turn', reason: 'cancellation_timeout' });
    expect(aborts).toBe(1);
    expect(session.status).toBe('interrupted');
    expect(await session.prepareMessage('blocked', { turnId: 'blocked', clientRequestId: 'blocked' })).toEqual({
      kind: 'rejected',
      reason: 'closed',
    });
    parked?.release();
    await session.dispose('interrupted');
  });

  it('tracks the queued turn that becomes active', async () => {
    const streams: Array<ReturnType<typeof parkedStream>> = [];
    const factory = makeFactory(root(), undefined, {
      activeCancelTimeoutMs: 5,
      createAgentClient: () =>
        ({
          ...partialClient(),
          startStream: async () => {
            const next = parkedStream();
            streams.push(next);
            return next.stream;
          },
        } as ConversationAgentClient),
    });
    const session = await factory.create(binding(root(), 'queued-active'));
    for (const [turnId, requestId] of [
      ['turn-a', 'request-a'],
      ['turn-b', 'request-b'],
    ]) {
      const prepared = await session.prepareMessage(turnId, { turnId, clientRequestId: requestId });
      if (prepared.kind !== 'prepared') throw new Error('test setup');
      await session.commitMessage(prepared.leaseId);
    }
    await wait(5);
    expect(session.status).toBe('running');
    expect(streams).toHaveLength(1);
    streams[0]!.release();
    await wait(10);
    expect(streams).toHaveLength(2);
    expect(session.status).toBe('running');
    const outcome = await session.abort('turn-b');
    expect(outcome.kind).toBe('interrupted');
    expect(session.status).toBe('interrupted');
    streams[1]!.release();
    await session.dispose('interrupted');
  });

  it('enforces the finite prepared queue and fails closed after disposal', async () => {
    const factory = makeFactory(root());
    const session = await factory.create(binding(root(), 'capacity'));
    const leases: string[] = [];
    for (let index = 0; index < 32; index++) {
      const result = await session.prepareMessage(`message-${index}`, {
        turnId: `turn-${index}`,
        clientRequestId: `request-${index}`,
      });
      expect(result.kind).toBe('prepared');
      if (result.kind === 'prepared') leases.push(result.leaseId);
    }
    expect(
      await session.prepareMessage('overflow', { turnId: 'turn-overflow', clientRequestId: 'request-overflow' }),
    ).toEqual({
      kind: 'rejected',
      reason: 'queue_full',
    });
    await session.cancelPreparedMessage(leases[0]!);
    expect(
      (await session.prepareMessage('released', { turnId: 'turn-released', clientRequestId: 'request-released' })).kind,
    ).toBe('prepared');
    await session.dispose();
    expect(
      await session.prepareMessage('closed', { turnId: 'turn-closed', clientRequestId: 'request-closed' }),
    ).toEqual({
      kind: 'rejected',
      reason: 'closed',
    });
  });
});
