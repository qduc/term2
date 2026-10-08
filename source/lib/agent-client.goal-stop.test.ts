import { afterEach, expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
import type { DurableGoal } from '../services/logging/conversation-log-events.js';
import { GOAL_STOP_REMINDER_PREFIX } from '../services/conversation/durable-goal-stop-check.js';
import { createGoalCheckToolDefinition } from '../tools/agent/goal-check.js';

/** Composition: only the owned root client wires the active-goal stop check. */

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

function registerTextOnlyProvider(name: string) {
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
          output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'done' }] }],
        };
      },
    }),
    fetchModels: async () => [],
  });
  return { provider, requests };
}

const goal: DurableGoal = { id: 'g', outcome: 'Ship the feature', status: 'active' };
const sessionContextService = { runWithContext: <T>(_c: unknown, fn: () => T) => fn(), getContext: () => null } as any;

it('the root client requires a goal self-check before a normal stop and returns control at the limit', async () => {
  const { provider, requests } = registerTextOnlyProvider('goal-stop-root');
  const instance = new AgentClient({
    deps: { logger, settings: settingsFor(provider), sessionContextService, getGoal: () => goal },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const stream = await instance.startStream('ship it');
    await stream.completed;

    expect(requests[0]!.tools?.map((tool: any) => tool.name)).toContain('goal_check');
    expect(requests[0]!.instructions).toContain('While this goal is active, finish every turn by calling `goal_check`');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1]!.input)).toContain(GOAL_STOP_REMINDER_PREFIX);
    expect(stream.terminalCause).toBe('goal_check_unresolved');
  } finally {
    instance.dispose();
  }
});

it('a transient (subagent/role) client never runs the goal stop check', async () => {
  const { provider, requests } = registerTextOnlyProvider('goal-stop-transient');
  const instance = new AgentClient({
    agentOverride: {
      name: 'role',
      model: 'test-model',
      instructions: '',
      tools: [createGoalCheckToolDefinition({ getGoal: () => goal })],
    },
    deps: { logger, settings: settingsFor(provider), sessionContextService, getGoal: () => goal },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const stream = await instance.startStream('do the delegated task');
    await stream.completed;
    expect(requests).toHaveLength(1);
    expect(stream.terminalCause).toBeUndefined();
  } finally {
    instance.dispose();
  }
});
