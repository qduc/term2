import { describe, expect, it, vi } from 'vitest';
import { ConversationService } from './conversation-service.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { createMockStream } from '../test-helpers/mock-stream.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const logger = {
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

const client = (): ConversationAgentClient =>
  ({
    chat: async () => '',
    abort: () => {},
    setModelSelection: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => createMockStream([]),
    continueRunStream: async () => createMockStream([]),
  } as ConversationAgentClient);

function makeService(): ConversationService {
  return new ConversationService({
    agentClient: client(),
    toolOwnership: new ToolOwnershipRegistry(),
    sessionId: 'handle-test',
    sessionStartedAt: '2026-09-29T00:00:00.000Z',
    deps: { logger, sessionContextService },
  });
}

describe('SessionHandle', () => {
  it('uses the service runtime for both admission and event observation', async () => {
    const service = makeService();
    const prepare = vi.spyOn(service, 'prepareMessage');
    const setEventSink = vi.spyOn(service, 'setEventSink');
    const events: unknown[] = [];
    service.sessionHandle.setEventSink((event) => {
      events.push(event);
    });
    expect(setEventSink).toHaveBeenCalledTimes(1);

    const result = await service.sessionHandle.prepare('hello', {
      turnId: 'turn-1',
      clientRequestId: 'request-1',
    });

    expect(prepare).toHaveBeenCalledWith('hello', { turnId: 'turn-1', clientRequestId: 'request-1' });
    expect(result).toEqual({ kind: 'prepared', leaseId: expect.any(String), turnId: 'turn-1' });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('expected prepared admission');
    expect(service.sessionHandle.sessionId).toBe(service.sessionId);
    expect(service.sessionHandle.sessionStartedAt).toBe(service.sessionStartedAt);
    expect(events).toEqual([]);
    await service.sessionHandle.cancelPrepared(result.leaseId);
    await service.shutdown();
  });

  it('cancels a prepared admission through the same queue', async () => {
    const service = makeService();
    const result = await service.sessionHandle.prepare('hello', {
      turnId: 'turn-2',
      clientRequestId: 'request-2',
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('expected prepared admission');

    await service.sessionHandle.cancelPrepared(result.leaseId);
    await expect(service.sessionHandle.commit(result.leaseId)).rejects.toThrow();
    await service.shutdown();
  });

  it('makes shutdown idempotent', async () => {
    const service = makeService();
    await expect(Promise.all([service.sessionHandle.shutdown(), service.sessionHandle.shutdown()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
