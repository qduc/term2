import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerSession } from './server-session.js';
import type { SessionHandle } from '../core/index.js';

const binding = {
  sessionId: 'session-handle',
  ownerUserId: 'owner',
  workspaceId: 'workspace',
  grantVersion: 1,
  canonicalRoot: '/tmp/session-handle',
  access: 'read' as const,
};

const composition = {
  settings: { providerId: 'fixture', modelId: 'fixture' },
  providerBroker: {},
  dispose: vi.fn(),
} as any;

const policy = { maxActiveTurnMs: 10_000, shutdownGraceMs: 10 } as any;

function createHarness() {
  let eventSink: ((event: any) => void | PromiseLike<void>) | null = null;
  let queuedObserver: ((start: { requestId: string }) => void) | null = null;
  const calls: string[] = [];
  const handle: SessionHandle = {
    sessionId: binding.sessionId,
    sessionStartedAt: new Date(0).toISOString(),
    prepare: vi.fn(async () => {
      calls.push('handle.prepare');
      return { kind: 'prepared' as const, leaseId: 'lease', turnId: 'turn' };
    }),
    commit: vi.fn(async () => {
      calls.push('handle.commit');
      queuedObserver?.({ requestId: 'turn' });
    }),
    cancelPrepared: vi.fn(async () => {
      calls.push('handle.cancelPrepared');
    }),
    resolveInteraction: vi.fn(() => {
      calls.push('handle.resolveInteraction');
      return { kind: 'resolved' as const, interactionId: 1, approval: {}, answer: 'approve' };
    }),
    snapshot: vi.fn(() => ({})),
    setEventSink: vi.fn((sink) => {
      calls.push('handle.setEventSink');
      eventSink = sink;
    }),
    setQueuedTurnStartObserver: vi.fn((observer) => {
      calls.push('handle.setQueuedTurnStartObserver');
      queuedObserver = observer;
    }),
    abortAndDiscard: vi.fn(async () => {
      calls.push('handle.abortAndDiscard');
      return { proven: true, discardedTurnIds: [] };
    }),
    shutdown: vi.fn(async () => {
      calls.push('handle.shutdown');
    }),
  };
  const service = {
    // These methods deliberately throw: normal lifecycle calls must not use
    // the concrete service when a handle is supplied.
    prepareMessage: vi.fn(() => {
      throw new Error('service prepare used');
    }),
    commitMessage: vi.fn(() => {
      throw new Error('service commit used');
    }),
    cancelPreparedMessage: vi.fn(() => {
      throw new Error('service cancel used');
    }),
    resolvePendingInteraction: vi.fn(() => {
      throw new Error('service interaction used');
    }),
    abortAndDiscard: vi.fn(() => {
      throw new Error('service abort used');
    }),
    shutdown: vi.fn(() => {
      throw new Error('service shutdown used');
    }),
    setEventSink: vi.fn(),
    setQueuedTurnStartObserver: vi.fn(),
    consumeFailureDiscardedTurnIds: vi.fn(() => []),
  } as any;
  return {
    handle,
    service,
    calls,
    emit: (event: any) => eventSink?.(event),
    start: (id: string) => queuedObserver?.({ requestId: id }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('ServerSession SessionHandle boundary', () => {
  it('routes submission, interaction resolution, abort, and events through one handle', async () => {
    const harness = createHarness();
    const events: string[] = [];
    const session = new ServerSession({
      binding,
      service: harness.service,
      handle: harness.handle,
      composition,
      policy,
      eventSink: (event) => {
        events.push(event.type);
      },
    });

    const prepared = await session.prepareMessage('hello', { turnId: 'turn', clientRequestId: 'request' });
    expect(prepared.kind).toBe('prepared');
    await session.commitMessage('lease');
    expect(
      session.resolvePendingInteraction({ interactionId: 'interaction', revision: 1, answer: 'approve' } as any),
    ).toEqual({
      kind: 'resolved',
      interactionId: 1,
      approval: {},
      answer: 'approve',
    });
    await harness.emit({ type: 'approval_required' });
    expect(events).toEqual(['approval_required']);
    expect(await session.abort('turn')).toEqual({ kind: 'aborted', turnId: 'turn', discardedTurnIds: [] });

    expect(harness.calls).toEqual([
      'handle.setQueuedTurnStartObserver',
      'handle.setEventSink',
      'handle.prepare',
      'handle.commit',
      'handle.resolveInteraction',
      'handle.abortAndDiscard',
    ]);
    expect(harness.service.prepareMessage).not.toHaveBeenCalled();
    expect(harness.service.commitMessage).not.toHaveBeenCalled();
    expect(harness.service.resolvePendingInteraction).not.toHaveBeenCalled();
    await session.dispose();
    expect(harness.handle.shutdown).toHaveBeenCalledTimes(1);
    expect(harness.service.shutdown).not.toHaveBeenCalled();
  });
});
