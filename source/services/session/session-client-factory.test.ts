import { expect, it, vi } from 'vitest';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { createCallerOwnedSessionClientFactory, createOwnedSessionClientFactory } from './session-client-factory.js';

const client = (dispose = vi.fn()) => ({ dispose } as unknown as ConversationAgentClient & { dispose: () => void });

it('creates a distinct owned client for each session and disposes each handle once', () => {
  const createdFor: string[] = [];
  const clients: Array<ConversationAgentClient & { dispose: () => void }> = [];
  const factory = createOwnedSessionClientFactory((sessionId) => {
    createdFor.push(sessionId);
    const created = client();
    clients.push(created);
    return created;
  });

  const first = factory.create('session-a');
  const second = factory.create('session-b');
  first.dispose();
  first.dispose();
  second.dispose();

  expect(createdFor).toEqual(['session-a', 'session-b']);
  expect(first.agentClient).not.toBe(second.agentClient);
  expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);
  expect(clients[1]?.dispose).toHaveBeenCalledTimes(1);
});

it('never disposes a caller-owned compatibility client', () => {
  const callerOwned = client();
  const handle = createCallerOwnedSessionClientFactory(callerOwned).create('session-a');

  handle.dispose();

  expect(handle.agentClient).toBe(callerOwned);
  expect(callerOwned.dispose).not.toHaveBeenCalled();
});
