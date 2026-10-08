import { afterEach, expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
import type { DurableGoal } from '../services/logging/conversation-log-events.js';
import { createGoalCheckToolDefinition } from '../tools/agent/goal-check.js';

/**
 * Composition: a recorded achieved goal_check closes the goal only through the
 * owned root client's stop seam, handing the achieved goal to the surface.
 */

const providers = new Set<string>();
afterEach(() => {
  for (const provider of providers) unregisterProvider(provider);
  providers.clear();
});

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
  log: () => {},
} as unknown as ILoggingService;

const settingsFor = (provider: string): ISettingsService => {
  const values: Record<string, unknown> = {
    'agent.modelSelection': { model: 'test-model', provider },
    'agent.retryAttempts': 0,
    'agent.reasoningEffort': 'default',
  };
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => void (values[key] = value),
    getDynamic: (key: string) => values[key],
    setDynamic: (key: string, value: unknown) => void (values[key] = value),
    setPersistent: (key: string, value: unknown) => void (values[key] = value),
    setPersistentDynamic: (key: string, value: unknown) => void (values[key] = value),
  } as ISettingsService;
};

function registerScriptedProvider(
  name: string,
  // Completion output items for the n-th request (1-based).
  script: (request: StreamedModelTurnRequest, n: number) => any[],
) {
  const provider = `${name}-${Date.now()}`;
  providers.add(provider);
  const requests: StreamedModelTurnRequest[] = [];
  registerProvider({
    id: provider,
    label: provider,
    createStreamedModel: () => ({
      async *stream(request: StreamedModelTurnRequest) {
        requests.push(request);
        yield {
          type: 'completion' as const,
          responseId: `r-${requests.length}`,
          output: script(request, requests.length),
        };
      },
    }),
    fetchModels: async () => [],
  });
  return { provider, requests };
}

const goal: DurableGoal = { id: 'g', outcome: 'Ship the feature', status: 'active' };
const sessionContextService = { runWithContext: <T>(_c: unknown, fn: () => T) => fn(), getContext: () => null } as any;

const achievedCall = (id: string) => ({
  type: 'tool_call' as const,
  id,
  name: 'goal_check',
  arguments: JSON.stringify({ status: 'achieved', evidence: 'shipped and verified' }),
});
const text = (value: string) => [{ type: 'message' as const, content: [{ type: 'text' as const, text: value }] }];

/**
 * Approve every pending call and resume until the run settles. The bare client
 * surfaces each continuation's calls for the session's batch coordinator, which
 * passes tools whose own policy needs no approval (goal_check) without a prompt.
 */
async function approveUntilSettled(instance: AgentClient, stream: any) {
  let current = stream;
  while (current.interruptions?.length) {
    for (const interruption of current.interruptions) current.state.approve?.(interruption);
    current = await instance.continueRunStream(current.state);
    await current.completed;
  }
  return current;
}

function goalSurface() {
  const state: { current: DurableGoal | undefined } = { current: goal };
  const writes: DurableGoal[] = [];
  return {
    state,
    writes,
    deps: {
      getGoal: () => state.current,
      onGoalAchieved: (next: DurableGoal) => {
        writes.push(next);
        state.current = next;
      },
    },
  };
}

it('the root client closes the goal once across an approval resume, and not again on the next turn', async () => {
  const { provider, requests } = registerScriptedProvider('goal-close-root', (_request, n) => {
    if (n === 1) {
      return [
        {
          type: 'tool_call' as const,
          id: 'call-1',
          name: 'shell',
          arguments: '{"command":"true","sandbox":"unsandboxed"}',
        },
      ];
    }
    if (n === 2) return [achievedCall('call-2')];
    return text(n === 3 ? 'Shipped.' : 'Anything else?');
  });
  const settings = settingsFor(provider);
  settings.set('sandbox.enabled' as never, true as never);
  const surface = goalSurface();
  const instance = new AgentClient({
    deps: { logger, settings, sessionContextService, ...surface.deps },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const first = await instance.startStream('ship it');
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    expect(surface.writes).toEqual([]);
    const resumed = await approveUntilSettled(instance, first);
    expect(requests).toHaveLength(3);
    expect(surface.writes).toEqual([{ ...goal, status: 'achieved' }]);

    const next = await instance.startStream('continue');
    await next.completed;
    expect(requests).toHaveLength(4);
    expect(surface.writes).toHaveLength(1);
  } finally {
    instance.dispose();
  }
});

it('a transient (subagent/role) client never closes the goal, even with a recorded achieved check', async () => {
  const { provider, requests } = registerScriptedProvider('goal-close-transient', (_request, n) =>
    n === 1 ? [achievedCall('call-1')] : text('Done.'),
  );
  const surface = goalSurface();
  const instance = new AgentClient({
    agentOverride: {
      name: 'role',
      model: 'test-model',
      instructions: '',
      tools: [createGoalCheckToolDefinition({ getGoal: surface.deps.getGoal })],
    },
    deps: { logger, settings: settingsFor(provider), sessionContextService, ...surface.deps },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const stream = await instance.startStream('do the delegated task');
    await stream.completed;
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.input)).toContain('Self-check recorded: achieved');
    expect(surface.writes).toEqual([]);
    expect(surface.state.current).toBe(goal);
  } finally {
    instance.dispose();
  }
});
