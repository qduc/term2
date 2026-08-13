import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { createRunSubagentToolDefinition } from '../tools/agent/run-subagent.js';
import type { NestedSubagentResult } from '../services/subagents/types.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

const providers = new Set<string>();
const makeSettings = (provider: string, overrides: Record<string, unknown> = {}): ISettingsService => {
  const values: Record<string, unknown> = {
    'agent.provider': provider,
    'agent.model': 'test-model',
    'agent.retryAttempts': 2,
    'agent.reasoningEffort': 'default',
    ...overrides,
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
const logger: ILoggingService = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
  log: () => {},
} as ILoggingService;
const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  getContext: () => null,
} as any;

const client = (
  provider: string,
  options: Record<string, unknown> = {},
  settingOverrides: Record<string, unknown> = {},
) =>
  new AgentClient({
    ...options,
    deps: { logger, settings: makeSettings(provider, settingOverrides), sessionContextService },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);

afterEach(() => {
  for (const provider of providers) {
    // Providers are intentionally process-global; unique IDs keep this file
    // isolated without mutating the registry during a test.
    void provider;
  }
});

describe('AgentClient application-run-loop execution', () => {
  it('uses local compaction for an unsupported provider only when auto mode is selected', async () => {
    const provider = `local-compaction-auto-${Date.now()}`;
    providers.add(provider);
    const requests: any[] = [];
    registerProvider({
      id: provider,
      label: 'Local compaction fallback provider',
      createStreamedModel: () => ({
        async *stream(request: any) {
          requests.push(request);
          const summarizing = request.instructions?.includes('You compact historical conversation data');
          const text = summarizing ? 'fixture local summary' : 'ordinary answer';
          yield {
            type: 'completion',
            responseId: summarizing ? 'summary-response' : 'ordinary-response',
            output: [{ type: 'message', content: [{ type: 'text', text }] }],
          };
        },
      }),
      fetchModels: async () => [],
    });
    const instance = client(
      provider,
      { agentOverride: { name: 'override', model: 'test-model', instructions: 'test', tools: [] } },
      {
        'agent.contextCompaction.enabled': true,
        'agent.contextCompaction.mode': 'auto',
        'agent.contextCompaction.compactThreshold': 0.8,
        'agent.contextCompaction.compactThresholdTokens': 1_000,
        'agent.reasoningEffort': 'high',
      },
    );
    const input = [
      { role: 'user' as const, type: 'message' as const, content: `cold-${'x'.repeat(5_000)}` },
      { role: 'assistant' as const, type: 'message' as const, content: 'cold answer' },
      { role: 'user' as const, type: 'message' as const, content: 'hot one' },
      { role: 'assistant' as const, type: 'message' as const, content: 'hot answer' },
      { role: 'user' as const, type: 'message' as const, content: 'hot two' },
    ];

    const stream = await instance.startStream(input);
    await stream.completed;

    expect(requests).toHaveLength(2);
    expect(requests[0].instructions).toContain('You compact historical conversation data');
    expect(requests[0].reasoning?.effort).toBe('high');
    expect(requests[1].input[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(requests[1].input)).toContain('fixture local summary');
    expect(JSON.stringify(requests[1].input)).not.toContain('cold-');
    instance.dispose();

    requests.length = 0;
    const nativeInstance = client(
      provider,
      { agentOverride: { name: 'override', model: 'test-model', instructions: 'test', tools: [] } },
      {
        'agent.contextCompaction.enabled': true,
        'agent.contextCompaction.mode': 'native',
        'agent.contextCompaction.compactThreshold': 0.8,
        'agent.contextCompaction.compactThresholdTokens': 1_000,
      },
    );
    const nativeStream = await nativeInstance.startStream(input);
    await nativeStream.completed;
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].input)).toContain('cold-');
    nativeInstance.dispose();
  });

  it('fails with a typed error instead of dispatching when the protected hot tail cannot fit', async () => {
    const provider = `local-compaction-hard-fit-${Date.now()}`;
    providers.add(provider);
    let requests = 0;
    registerProvider({
      id: provider,
      label: 'Local compaction hard-fit provider',
      createStreamedModel: () => ({
        async *stream() {
          requests += 1;
          yield { type: 'completion', responseId: 'unexpected', output: [] };
        },
      }),
      fetchModels: async () => [],
    });
    const instance = client(
      provider,
      { agentOverride: { name: 'override', model: 'test-model', instructions: 'test', tools: [] } },
      {
        'agent.contextCompaction.enabled': true,
        'agent.contextCompaction.mode': 'auto',
        'agent.contextCompaction.compactThreshold': 0.8,
        'agent.contextCompaction.compactThresholdTokens': 1_000,
      },
    );
    const stream = await instance.startStream([
      { role: 'user', type: 'message', content: 'cold' },
      { role: 'assistant', type: 'message', content: 'cold answer' },
      { role: 'user', type: 'message', content: 'hot one' },
      { role: 'assistant', type: 'message', content: 'hot answer' },
      { role: 'user', type: 'message', content: `protected-${'x'.repeat(5_000)}` },
    ] as any);

    await expect(stream.completed).rejects.toMatchObject({ code: 'context_compaction_hard_fit' });
    expect(requests).toBe(0);
    instance.dispose();
  });

  it('starts eligible foreground explorer calls from one response together and preserves provider result order', async () => {
    const provider = `parallel-explorers-${Date.now()}`;
    providers.add(provider);
    const starts: string[] = [];
    const deferred = new Map<string, { resolve: (result: NestedSubagentResult) => void }>();
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let modelCalls = 0;

    registerProvider({
      id: provider,
      label: 'Parallel explorer test provider',
      createStreamedModel: () => ({
        async *stream(request: any) {
          requests.push(request);
          modelCalls += 1;
          if (modelCalls === 1) {
            yield {
              type: 'completion',
              responseId: 'parallel-response',
              output: [
                {
                  type: 'tool_call',
                  id: 'call-first',
                  name: 'run_subagent',
                  arguments: JSON.stringify({ execution: 'foreground', role: 'explorer', task: 'first' }),
                },
                {
                  type: 'tool_call',
                  id: 'call-second',
                  name: 'run_subagent',
                  arguments: JSON.stringify({ execution: 'foreground', role: 'explorer', task: 'second' }),
                },
              ],
            };
            return;
          }
          yield {
            type: 'completion',
            responseId: 'parallel-done',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        },
      }),
      fetchModels: async () => [],
    });

    const runSubagent = async ({ task }: { task: string }): Promise<NestedSubagentResult> => {
      starts.push(task);
      return await new Promise((resolve) => deferred.set(task, { resolve }));
    };
    const tool = createRunSubagentToolDefinition({ runSubagent: runSubagent as any });
    const instance = client(provider, {
      agentOverride: { name: 'override', model: 'test-model', instructions: 'test', tools: [tool] },
      maxTurns: 2,
    });

    const stream = await instance.startStream('run');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(['first', 'second']);

    deferred.get('second')?.resolve({
      agentId: 'second',
      role: 'explorer',
      status: 'completed',
      finalText: 'second result',
      filesChanged: [],
      toolsUsed: [],
    });
    deferred.get('first')?.resolve({
      agentId: 'first',
      role: 'explorer',
      status: 'completed',
      finalText: 'first result',
      filesChanged: [],
      toolsUsed: [],
    });

    await stream.completed;
    expect(requests[1].input.filter((item: any) => item.type === 'tool_result').map((item: any) => item.id)).toEqual([
      'call-first',
      'call-second',
    ]);
    instance.dispose();
  });

  it('executes an override agent with its original tool definitions', async () => {
    const provider = `override-direct-${Date.now()}`;
    providers.add(provider);
    let executed = 0;
    let turn = 0;
    registerProvider({
      id: provider,
      label: 'Override direct test provider',
      createStreamedModel: () => ({
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: 'completion',
              responseId: 'one',
              output: [{ type: 'tool_call', id: 'call-1', name: 'identity', arguments: '{}' }],
            };
          } else {
            yield {
              type: 'completion',
              responseId: 'two',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            };
          }
        },
      }),
      fetchModels: async () => [],
    });
    const tool = {
      name: 'identity',
      description: 'identity',
      parameters: {},
      needsApproval: async () => false,
      execute: async () => {
        executed += 1;
        return 'ok';
      },
    } as any;
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [tool] } as any;
    const instance = client(provider, {
      agentOverride: overrideAgent,
      maxTurns: 2,
    });
    const stream = await instance.startStream('run');
    await stream.completed;
    expect(executed).toBe(1);
    instance.dispose();

    turn = 0;
    const defaultInstance = client(provider, { agentOverride: overrideAgent });
    const defaultStream = await defaultInstance.startStream('run');
    await expect(defaultStream.completed).rejects.toThrow('Max turns (1) exceeded');
    defaultInstance.dispose();
  });

  it('keeps a steer waiting across the approval pause it resumes through', async () => {
    // Resuming a paused turn goes through AgentClient, which stops whatever is
    // streaming first. Doing that with the turn-ending abort discarded the very
    // injections waiting for the segment about to start — invisible to a test
    // that drives ApplicationRunLoop.continueRunStream directly.
    const provider = `steer-across-pause-${Date.now()}`;
    providers.add(provider);
    let turn = 0;
    registerProvider({
      id: provider,
      label: 'Steer across pause test provider',
      createStreamedModel: () => ({
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: 'completion',
              responseId: 'one',
              output: [{ type: 'tool_call', id: 'call-1', name: 'risky', arguments: '{}' }],
            };
          } else {
            yield {
              type: 'completion',
              responseId: 'two',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            };
          }
        },
      }),
      fetchModels: async () => [],
    });
    const tool = {
      name: 'risky',
      description: 'needs approval',
      parameters: {},
      needsApproval: async () => true,
      execute: async () => 'ok',
    } as any;
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [tool] } as any;
    const instance = client(provider, { agentOverride: overrideAgent, maxTurns: 4 });

    const stream = await instance.startStream('run');
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);

    const steered = instance.steer([{ type: 'message', role: 'user', content: 'one more thing' }]);
    (stream.state as any).approve?.({});
    const resumed = await instance.continueRunStream(stream.state!);
    await expect(steered).resolves.toBe('admitted');
    await resumed.completed;

    expect(resumed.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'user', content: 'one more thing' })]),
    );
    instance.dispose();
  });

  it('admits a steer offered before the turn has reached its first request', async () => {
    // The queue reports a turn as running the moment it dispatches, but no run
    // is in flight until startStream has finished preparing — for codex that
    // includes a network model-discovery call. A steer typed in that window was
    // refused for want of a run and silently demoted to a queued turn.
    const provider = `steer-before-run-${Date.now()}`;
    providers.add(provider);
    registerProvider({
      id: provider,
      label: 'Steer before run test provider',
      createStreamedModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'one',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        },
      }),
      fetchModels: async () => [],
    });
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [] } as any;
    const instance = client(provider, { agentOverride: overrideAgent, maxTurns: 4 });

    instance.openTurn();
    const steered = instance.steer([{ type: 'message', role: 'user', content: 'one more thing' }]);
    const stream = await instance.startStream('run');
    await expect(steered).resolves.toBe('admitted');
    await stream.completed;

    expect(stream.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'user', content: 'one more thing' })]),
    );
    instance.closeTurn();
    instance.dispose();
  });

  it('keeps a steer waiting when the same turn restarts its stream after a retry', async () => {
    // A transient failure sends TurnWorkflow back through startStream for the
    // *same* turn. That path opened with the turn-ending abort(), which threw
    // away a steer the user had already been shown as accepted — the same class
    // of bug as the approval-pause resume, one path further along.
    const provider = `steer-across-retry-${Date.now()}`;
    providers.add(provider);
    let turn = 0;
    registerProvider({
      id: provider,
      label: 'Steer across retry test provider',
      createStreamedModel: () => ({
        async *stream() {
          turn += 1;
          if (turn === 1) throw new Error('transient upstream failure');
          yield {
            type: 'completion',
            responseId: 'two',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        },
      }),
      fetchModels: async () => [],
    });
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [] } as any;
    const instance = client(provider, { agentOverride: overrideAgent, maxTurns: 4 });

    instance.openTurn();
    const failed = await instance.startStream('run');
    await expect(failed.completed).rejects.toThrow('transient upstream failure');

    const steered = instance.steer([{ type: 'message', role: 'user', content: 'one more thing' }]);
    const retried = await instance.startStream('run');
    await expect(steered).resolves.toBe('admitted');
    await retried.completed;

    expect(retried.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'message', role: 'user', content: 'one more thing' })]),
    );
    instance.closeTurn();
    instance.dispose();
  });

  it('releases a steer still waiting when the turn closes without another request', async () => {
    // The turn scope must not become a leak: a message nobody admitted has to
    // be handed back so the caller sends it as its own turn.
    const provider = `steer-turn-close-${Date.now()}`;
    providers.add(provider);
    registerProvider({
      id: provider,
      label: 'Steer turn close test provider',
      createStreamedModel: () => ({
        async *stream() {
          yield { type: 'completion', responseId: 'one', output: [] };
        },
      }),
      fetchModels: async () => [],
    });
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [] } as any;
    const instance = client(provider, { agentOverride: overrideAgent, maxTurns: 4 });

    instance.openTurn();
    const steered = instance.steer([{ type: 'message', role: 'user', content: 'never admitted' }]);
    instance.closeTurn();
    await expect(steered).resolves.toBe('released');
    instance.dispose();
  });

  it('fails clearly when a provider has no streamed-model factory', async () => {
    const provider = `runner-only-${Date.now()}`;
    providers.add(provider);
    registerProvider({
      id: provider,
      label: 'Missing streamed model test provider',
      fetchModels: async () => [],
    });
    const instance = client(provider);
    const stream = await instance.startStream('run');
    await expect(stream.completed).rejects.toThrow('does not expose an application streamed model');
    instance.dispose();
  });

  it('passes retry callback and aborts an active direct stream', async () => {
    const provider = `retry-cancel-${Date.now()}`;
    providers.add(provider);
    let retry: (() => void) | undefined;
    let resolve: (() => void) | undefined;
    registerProvider({
      id: provider,
      label: 'Retry cancellation test provider',
      createStreamedModel: (_model, deps) => {
        retry = deps.onRetry;
        return {
          async *stream(request: any) {
            retry?.();
            await new Promise<void>((done) => {
              resolve = done;
              request.signal?.addEventListener('abort', done, { once: true });
            });
            if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            yield { type: 'completion', responseId: 'done', output: [] };
          },
        };
      },
      fetchModels: async () => [],
    });
    const instance = client(provider);
    let retries = 0;
    instance.setRetryCallback(() => {
      retries += 1;
    });
    const stream = await instance.startStream('run');
    expect(retry).toBeTypeOf('function');
    expect(retries).toBe(1);
    instance.abort();
    resolve?.();
    await expect(stream.completed).rejects.toMatchObject({ name: 'AbortError' });
    instance.dispose();
  });
});
