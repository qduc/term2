import { expect, it, vi } from 'vitest';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { createCallerOwnedSessionClientFactory, createOwnedSessionClientFactory } from './session-client-factory.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PARENT_TOOL_OWNER } from '../approval/tool-owner.js';

const client = (dispose = vi.fn()) => ({ dispose } as unknown as ConversationAgentClient & { dispose: () => void });

it('creates a distinct registry for each session, passes it to its client, and clears it after disposal', () => {
  const createdFor: string[] = [];
  const registries: ToolOwnershipRegistry[] = [];
  const clients: Array<ConversationAgentClient & { dispose: () => void }> = [];
  const factory = createOwnedSessionClientFactory((sessionId, toolOwnership) => {
    createdFor.push(sessionId);
    registries.push(toolOwnership);
    const created = client();
    clients.push(created);
    return created;
  });

  const first = factory.create('session-a');
  const second = factory.create('session-b');
  first.toolOwnership.claim(['call-a'], PARENT_TOOL_OWNER);
  second.toolOwnership.claim(['call-b'], PARENT_TOOL_OWNER);
  first.dispose();
  first.dispose();
  second.dispose();

  expect(createdFor).toEqual(['session-a', 'session-b']);
  expect(first.agentClient).not.toBe(second.agentClient);
  expect(first.toolOwnership).toBe(registries[0]);
  expect(second.toolOwnership).toBe(registries[1]);
  expect(first.toolOwnership).not.toBe(second.toolOwnership);
  expect(first.toolOwnership.size).toBe(0);
  expect(second.toolOwnership.size).toBe(0);
  expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);
  expect(clients[1]?.dispose).toHaveBeenCalledTimes(1);
});

it('never disposes a caller-owned compatibility client', () => {
  const callerOwned = client();
  const toolOwnership = new ToolOwnershipRegistry();
  const handle = createCallerOwnedSessionClientFactory(callerOwned, toolOwnership).create('session-a');

  handle.dispose();

  expect(handle.agentClient).toBe(callerOwned);
  expect(handle.toolOwnership).toBe(toolOwnership);
  expect(callerOwned.dispose).not.toHaveBeenCalled();
});

it('disposal fail-closes its suspended gates and clears the capability without affecting a replacement', async () => {
  const factory = createOwnedSessionClientFactory((_sessionId, _ownership, _capability) => client());
  const oldHandle = factory.create('session-a');
  const replacement = factory.create('session-a');
  const oldPending = oldHandle.postExecutePending!;
  const oldCapability = oldHandle.postExecutePauseCapability!;
  oldCapability.setActiveRunId('old-run');
  const oldGate = oldPending.register({
    runId: 'old-run',
    toolCallId: 'call-old',
    toolName: 'shell',
    argumentsText: '{}',
  });
  const oldToken = oldPending.snapshot();

  oldHandle.dispose();

  await expect(oldGate).resolves.toBe('reject');
  expect(
    oldCapability.forTool({
      postExecutePause: { describe: () => ({ toolName: 'shell', argumentsText: '{}' }) },
    } as any),
  ).toBeTruthy();
  expect(
    oldPending.decide({
      revision: oldToken.revision,
      ids: oldToken.entries.map((entry) => entry.id),
      decision: 'approve',
    }),
  ).toEqual({ kind: 'invalid', reason: 'closed' });
  expect(replacement.postExecutePending!.snapshot().closed).toBe(false);
});
