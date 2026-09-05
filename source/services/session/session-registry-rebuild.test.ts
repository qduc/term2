import { expect, it } from 'vitest';
import { createSessionRuntime } from '../../core/index.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import {
  createMockAgentClient,
  createMockSettingsService,
  mockLogger,
  sessionContextService,
} from './test-helpers/conversation-session-fixtures.js';

const collect = async (events: AsyncIterable<ConversationEvent>): Promise<ConversationEvent[]> => {
  const collected: ConversationEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const interruptedStream = (callId: string, toolName: string): MockStream => {
  const stream = new MockStream([]);
  stream.interruptions = [
    {
      name: toolName,
      callId,
      agent: { name: 'test-agent' },
      arguments: JSON.stringify({}),
    },
  ];
  stream.state = {
    approve: () => undefined,
    reject: () => undefined,
  };
  return stream;
};

const registryWith = (verdict: boolean): ToolApprovalPolicyRegistry => {
  const registry = new ToolApprovalPolicyRegistry();
  registry.register({ toolName: 'rebuild_probe', needsApproval: () => verdict });
  return registry;
};

it('resolves post-rebuild turns against the rebuilt graph registry while pre-rebuild turns keep theirs', async () => {
  // Pinned semantics: a fresh user turn follows the client's current graph
  // registry (restoring pre-M1 post-rebuild freshness); an in-flight turn or
  // pending-approval continuation keeps the graph that produced it.
  const holder = { current: registryWith(false) };
  const streams = [
    interruptedStream('probe-call-1', 'rebuild_probe'),
    interruptedStream('probe-call-2', 'rebuild_probe'),
  ];
  const agentClient = createMockAgentClient({
    startStream: async () => streams.shift()!,
    getApprovalPolicyRegistry: () => holder.current,
  }) as ConversationAgentClient;
  const runtime = createSessionRuntime({
    sessionId: 'registry-rebuild',
    agentClient,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService([
        ['agent.provider', 'test-provider'],
        ['agent.model', 'test-model'],
      ]),
      sessionContextService,
    },
  } as never);

  try {
    // Turn 1 under the pre-rebuild graph auto-approves: no approval prompt.
    const first = await collect(runtime.turns.start('first turn'));
    expect(first.at(-1)?.type).not.toBe('approval_required');

    // Mid-session rebuild swaps the graph (AgentConfiguration.rebuildAgent
    // allocates a new registry and re-registers the rebuilt graph's tools).
    holder.current = registryWith(true);

    // Turn 2 follows the rebuilt graph and prompts for a human.
    const second = await collect(runtime.turns.start('second turn'));
    expect(second.at(-1)?.type).toBe('approval_required');
    expect(runtime.approval.getPending()).not.toBeNull();
  } finally {
    await runtime.shutdown();
  }
});
