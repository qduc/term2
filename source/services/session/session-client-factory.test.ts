import { expect, it, vi } from 'vitest';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { createCallerOwnedSessionClientFactory, createOwnedSessionClientFactory } from './session-client-factory.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { PARENT_TOOL_OWNER } from '../approval/tool-owner.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

const client = (dispose = vi.fn()) => ({ dispose } as unknown as ConversationAgentClient & { dispose: () => void });

it('creates a distinct registry and access capability for each session, then clears both after disposal', () => {
  const createdFor: string[] = [];
  const registries: ToolOwnershipRegistry[] = [];
  const clients: Array<ConversationAgentClient & { dispose: () => void }> = [];
  const factory = createOwnedSessionClientFactory(createMockSettingsService(), (sessionId, toolOwnership) => {
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
  first.access!.allowReadFolder('/outside/first');
  second.access!.allowReadFolder('/outside/second');
  first.dispose();
  first.dispose();
  second.dispose();

  expect(createdFor).toEqual(['session-a', 'session-b']);
  expect(first.agentClient).not.toBe(second.agentClient);
  expect(first.toolOwnership).toBe(registries[0]);
  expect(second.toolOwnership).toBe(registries[1]);
  expect(first.toolOwnership).not.toBe(second.toolOwnership);
  expect(first.access).not.toBe(second.access);
  expect(first.toolOwnership.size).toBe(0);
  expect(second.toolOwnership.size).toBe(0);
  expect(first.access!.allowsRead('/outside/first/file')).toBe(false);
  expect(second.access!.allowsRead('/outside/second/file')).toBe(false);
  expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);
  expect(clients[1]?.dispose).toHaveBeenCalledTimes(1);
});

it('never disposes a caller-owned compatibility client', () => {
  const callerOwned = client();
  const toolOwnership = new ToolOwnershipRegistry();
  const handle = createCallerOwnedSessionClientFactory(callerOwned, toolOwnership).create('session-a');

  handle.dispose();

  expect(handle.agentClient).toBe(callerOwned);
  expect(handle.continuationProjectionMode).toBe('legacy');
  expect(handle.toolOwnership).toBe(toolOwnership);
  expect(callerOwned.dispose).not.toHaveBeenCalled();
});

it('binds each owned root observer to its handle continuity and leaves caller-owned handles inert', () => {
  const captures: any[] = [];
  const factory = createOwnedSessionClientFactory(
    createMockSettingsService(),
    (_id, _ownership, _capability, _access, _mode, continuity, capture) => {
      captures.push({ continuity, capture });
      return client();
    },
  );
  const first = factory.create('first');
  const second = factory.create('second');
  captures[0].capture.observe({
    token: 'a',
    provider: 'openai',
    transport: 'http',
    model: 'gpt-5',
    endpoint: 'https://api.openai.com/v1',
    requestData: {},
    phase: 'terminal',
    responseId: 'response-a',
    prefixBinding: { snapshotIdentity: 'first:1', snapshotRevision: 1, lineage: 0 },
  });

  expect(captures[0].continuity).toBe(first.providerContinuity);
  expect(captures[1].continuity).toBe(second.providerContinuity);
  expect(first.providerContinuity!.checkpoint?.responseId).toBe('response-a');
  expect(second.providerContinuity!.checkpoint).toBeNull();
  expect(
    createCallerOwnedSessionClientFactory(client(), new ToolOwnershipRegistry()).create('caller').providerContinuity,
  ).toBeDefined();
});

it('freezes the OpenAI projection mode at owned-handle creation and passes it to the client callback', () => {
  let provider = 'openai';
  const settings = {
    get: (key: string) => (key === 'agent.provider' ? provider : undefined),
  } as any;
  const modes: string[] = [];
  const factory = createOwnedSessionClientFactory(
    settings,
    (_sessionId, _ownership, _capability, _access, continuationProjectionMode) => {
      modes.push(continuationProjectionMode);
      return client();
    },
  );

  const openAIHandle = factory.create('openai-session');
  provider = 'codex';
  const codexHandle = factory.create('codex-session');

  expect(openAIHandle.continuationProjectionMode).toBe('openai-provider');
  expect(openAIHandle.continuationProjectionMode).toBe('openai-provider');
  expect(codexHandle.continuationProjectionMode).toBe('legacy');
  expect(modes).toEqual(['openai-provider', 'legacy']);
});

it('disposal fail-closes its suspended gates and clears the capability without affecting a replacement', async () => {
  const factory = createOwnedSessionClientFactory(createMockSettingsService(), (_sessionId, _ownership, _capability) =>
    client(),
  );
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
