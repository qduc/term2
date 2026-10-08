import { afterEach, describe, expect, it } from 'vitest';
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
      // Snapshot the goal like the root agent does, so the check is recorded.
      resolveRequestSnapshot: () => ({ goal: surface.deps.getGoal() }),
      tools: [createGoalCheckToolDefinition({ getGoal: surface.deps.getGoal })],
    },
    deps: { logger, settings: settingsFor(provider), sessionContextService, ...surface.deps },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const stream = await instance.startStream('do the delegated task');
    await stream.completed;
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.input)).toContain(`Self-check recorded: [goal ${goal.id}] achieved`);
    expect(surface.writes).toEqual([]);
    expect(surface.state.current).toBe(goal);
  } finally {
    instance.dispose();
  }
});

/**
 * A goal set mid-turn (`/goal set` from the prompt or the control socket) adds
 * no history, so the turn's earlier check is still its latest tool activity.
 * That check judged the previous goal and must not close the new one.
 */
describe('a goal replaced mid-turn is never closed by the previous goal’s check', () => {
  const replacement: DurableGoal = { id: 'g2', outcome: 'Write the migration guide', status: 'active' };
  const replacementWithCriteria: DurableGoal = { ...replacement, successCriteria: 'Guide reviewed' };
  const achievedWithCriteria = (id: string) => ({
    ...achievedCall(id),
    arguments: JSON.stringify({ status: 'achieved', evidence: 'shipped', criteriaEvidence: 'vitest: 12 passed' }),
  });

  /**
   * `switchAt: n` replaces the goal while the n-th response streams (after its
   * request — and the goal rendered into it — was built). `'pause'` replaces it
   * while the first response's calls wait at the approval boundary.
   */
  async function runSwitch(next: DurableGoal, script: (n: number) => any[], switchAt: number | 'pause' = 2) {
    const surface = goalSurface();
    const { provider, requests } = registerScriptedProvider('goal-switch', (_request, n) => {
      if (n === switchAt) surface.state.current = next;
      return script(n);
    });
    const instance = new AgentClient({
      deps: { logger, settings: settingsFor(provider), sessionContextService, ...surface.deps },
      toolOwnership: new ToolOwnershipRegistry(),
    } as any);
    let pausedCalls: string[] = [];
    try {
      const stream = await instance.startStream('ship it');
      await stream.completed;
      pausedCalls = (stream.interruptions ?? []).map((item: any) => item.name);
      if (switchAt === 'pause') surface.state.current = next;
      await approveUntilSettled(instance, stream);
    } finally {
      instance.dispose();
    }
    return { surface, requests, pausedCalls };
  }

  const refused = 'goal_check was not recorded: the session goal changed after this response began';

  it('repro: an achieved check for G1, then setGoal(G2) before the final text, writes nothing', async () => {
    const { surface } = await runSwitch(replacement, (n) => (n === 1 ? [achievedCall('call-1')] : text('Shipped.')));
    expect(surface.writes).toEqual([]);
    expect(surface.state.current).toBe(replacement);
  });

  it('P1b: G1 criteria evidence does not close a G2 that has its own criteria', async () => {
    const { surface } = await runSwitch(replacementWithCriteria, (n) =>
      n === 1 ? [achievedWithCriteria('call-1')] : text('Shipped.'),
    );
    expect(surface.writes).toEqual([]);
    expect(surface.state.current).toBe(replacementWithCriteria);
  });

  // The goal changes while the response carrying the check is still streaming:
  // the check executes after the switch but judged the G1 shown in its request.
  it('R1: an achieved check from a response shown G1 does not close a G2 set while it streamed', async () => {
    const { surface, requests } = await runSwitch(
      replacement,
      (n) => (n === 1 ? [achievedCall('call-1')] : text('Shipped.')),
      1,
    );
    expect(surface.writes).toEqual([]);
    expect(requests[0]!.instructions).toContain(goal.outcome);
    expect(requests[0]!.instructions).not.toContain(replacement.outcome);
    // Refused at execution, so the seam reminds about G2 instead of closing it.
    expect(JSON.stringify(requests[1]!.input)).toContain(refused);
    expect(requests[1]!.instructions).toContain(replacement.outcome);
    expect(JSON.stringify(requests[2]!.input)).toContain('the latest goal_check was incomplete');
    expect(surface.state.current).toBe(replacement);
  });

  it('R1b: G1 criteria evidence from a response shown G1 does not close a G2 with its own criteria', async () => {
    const { surface, requests } = await runSwitch(
      replacementWithCriteria,
      (n) => (n === 1 ? [achievedWithCriteria('call-1')] : text('Shipped.')),
      1,
    );
    expect(surface.writes).toEqual([]);
    expect(JSON.stringify(requests[1]!.input)).toContain(refused);
    expect(surface.state.current).toBe(replacementWithCriteria);
  });

  it('a goal replaced while the check waits at the approval boundary is not closed when it resumes', async () => {
    const { surface, requests, pausedCalls } = await runSwitch(
      replacement,
      (n) => (n === 1 ? [achievedCall('call-1')] : text('Shipped.')),
      'pause',
    );
    // The check crossed a pause and resume; its request was shown G1.
    expect(pausedCalls).toEqual(['goal_check']);
    expect(surface.writes).toEqual([]);
    expect(JSON.stringify(requests[1]!.input)).toContain(refused);
    expect(surface.state.current).toBe(replacement);
  });

  it('a check from a response shown G2 closes G2 after an R1-style switch', async () => {
    const { surface, requests } = await runSwitch(
      replacement,
      (n) => (n === 1 ? [achievedCall('call-1')] : n === 2 ? [achievedCall('call-2')] : text('Shipped.')),
      1,
    );
    expect(JSON.stringify(requests[1]!.input)).toContain(refused);
    expect(surface.writes).toEqual([{ ...replacement, status: 'achieved' }]);
  });

  it('a check made after the switch still closes G2', async () => {
    const { surface, requests } = await runSwitch(replacement, (n) =>
      n === 1 ? [achievedCall('call-1')] : n === 3 ? [achievedCall('call-3')] : text('Shipped.'),
    );
    // The stale check earns a reminder instead of a close; the fresh one closes G2.
    expect(JSON.stringify(requests[2]!.input)).toContain('it was made for a different goal');
    expect(surface.writes).toEqual([{ ...replacement, status: 'achieved' }]);
  });
});
