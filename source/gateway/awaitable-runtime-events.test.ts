import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { ServerSession, type ServerSessionEventContext } from './server-session.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { createGatewayEventJournal } from './persistence/event-journal.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const binding = {
  sessionId: 'session-awaitable-events',
  ownerUserId: 'owner-a',
  workspaceId: 'workspace-a',
  grantVersion: 1,
  canonicalRoot: '/tmp/awaitable-runtime-events',
  access: 'read' as const,
};

const policy = {
  maxActiveTurnMs: 10_000,
  shutdownGraceMs: 10,
} as any;

const composition = {
  settings: { providerId: 'fixture', modelId: 'fixture-model' },
  providerBroker: {},
  executionContext: {},
  dispose: () => {},
} as any;

type FakeService = {
  eventSink?: (event: ConversationEvent) => void | PromiseLike<void>;
  setQueuedTurnStartObserver(observer: (execution: { requestId: string }) => void): void;
  setEventSink(sink: (event: ConversationEvent) => void | PromiseLike<void>): void;
  emit(event: ConversationEvent): Promise<void>;
  closeAdmission(): void;
  abortAndDiscard(): Promise<{ proven: boolean; discardedTurnIds: string[] }>;
  shutdown(): Promise<void>;
  dispose(): void;
  getPendingInteractionSnapshot(): null;
  consumeFailureDiscardedTurnIds(): string[];
};

function fakeService(): FakeService {
  const service = {
    setQueuedTurnStartObserver: () => {},
    setEventSink(sink: (event: ConversationEvent) => void | PromiseLike<void>) {
      service.eventSink = sink;
    },
    async emit(event: ConversationEvent) {
      await service.eventSink?.(event);
    },
    closeAdmission: () => {},
    abortAndDiscard: async () => ({ proven: true, discardedTurnIds: [] }),
    shutdown: async () => {},
    dispose: () => {},
    getPendingInteractionSnapshot: () => null,
    consumeFailureDiscardedTurnIds: () => [],
  } as unknown as FakeService;
  return service;
}

const approvalEvent: ConversationEvent = {
  type: 'approval_required',
  approval: { agentName: 'Agent', toolName: 'shell', argumentsText: 'echo safe' },
};
const terminalEvent: ConversationEvent = { type: 'final', finalText: 'done' };

function createSession(
  service: FakeService,
  eventSink: (event: ConversationEvent, context: ServerSessionEventContext) => void | PromiseLike<void>,
): ServerSession {
  return new ServerSession({
    binding,
    service: service as any,
    composition,
    policy,
    eventSink,
  });
}

describe('awaitable runtime event boundary', () => {
  it('does not advance runtime publication before critical event persistence settles', async () => {
    const service = fakeService();
    let release!: () => void;
    const journalReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    const session = createSession(service, async (runtimeEvent) => {
      await journalReady;
      observed.push(runtimeEvent.type);
    });

    const runtimeEmission = service.emit(approvalEvent);
    await Promise.resolve();
    expect(observed).toEqual([]);
    release();
    await runtimeEmission;
    expect(observed).toEqual(['approval_required']);

    await session.dispose();
  });

  it('preserves critical event order and latches the session when persistence rejects', async () => {
    const service = fakeService();
    let release!: () => void;
    const journalReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    const session = createSession(service, async (runtimeEvent) => {
      await journalReady;
      observed.push(runtimeEvent.type);
    });

    const approval = service.emit(approvalEvent);
    const terminal = service.emit(terminalEvent);
    await Promise.resolve();
    expect(observed).toEqual([]);
    release();
    await Promise.all([approval, terminal]);
    expect(observed).toEqual(['approval_required', 'final']);
    await session.dispose();

    const rejectingService = fakeService();
    const rejectingSession = createSession(rejectingService, async () => {
      throw new Error('journal fsync failed');
    });
    await expect(rejectingService.emit(approvalEvent)).rejects.toThrow('journal fsync failed');
    expect(rejectingSession.status).toBe('interrupted');
    await rejectingSession.dispose('interrupted');
  });

  it('publishes approval and terminal events only after the real journal append completes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'term2-awaitable-events-'));
    tempRoots.push(root);
    const sessionId = 'session-real-journal';
    const journal = createGatewayEventJournal({ sessionId, directory: root });
    const service = fakeService();
    const published: string[] = [];
    journal.subscribeFrom(null, (event) => {
      // Journal subscribers run after the append's fsync boundary. Seeing the
      // event here is the durable publication assertion, not a fake callback.
      published.push(event.type);
      expect(journal.events().some((candidate) => candidate.type === event.type)).toBe(true);
    });
    const session = createSession(service, async (runtimeEvent) => {
      if (runtimeEvent.type === 'approval_required') {
        await journal.append(
          {
            sessionId,
            type: 'approval_required',
            payload: {
              turnId: 'turn-real-journal',
              interaction: {
                version: 1,
                interactionId: 'interaction-real-journal',
                kind: 'tool_approval',
                variant: 'ordinary_tool',
                descriptor: { agentName: 'Agent', toolName: 'shell', argumentsText: 'echo safe' },
                choices: [{ id: 'approve', label: 'Approve' }],
                revision: 1,
              },
            },
          },
          { durability: 'critical' },
        );
      } else if (runtimeEvent.type === 'final') {
        await journal.append(
          {
            sessionId,
            type: 'turn_completed',
            payload: { turnId: 'turn-real-journal', outcome: 'completed', text: runtimeEvent.finalText },
          },
          { durability: 'critical' },
        );
      }
    });

    await service.emit(approvalEvent);
    await service.emit(terminalEvent);
    expect(published).toEqual(['approval_required', 'turn_completed']);
    await session.dispose();
    journal.close();
  });
});
