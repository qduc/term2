import { it, expect, beforeAll, vi } from 'vitest';
import { AgentRunOrchestrator, type AgentRunOrchestratorDeps } from './agent-run-orchestrator.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { registerProvider } from '../providers/registry.js';
import type { Runner } from '@openai/agents';

// ========== Mock types ==========

interface MockLogger extends ILoggingService {
  debugCalls: any[];
  warnCalls: any[];
  errorCalls: any[];
  clearCorrelationIdCalls: number;
  setCorrelationIdCalls: string[];
  getCorrelationIdReturns: string | undefined;
}

function createMockLogger(): MockLogger {
  const calls: {
    debug: any[][];
    warn: any[][];
    error: any[][];
    clearCorrelationId: number;
    setCorrelationId: string[];
    getCorrelationId: string | undefined;
  } = {
    debug: [],
    warn: [],
    error: [],
    clearCorrelationId: 0,
    setCorrelationId: [],
    getCorrelationId: undefined,
  };
  return {
    debug: (...args: any[]) => {
      calls.debug.push(args);
    },
    info: () => {},
    warn: (...args: any[]) => {
      calls.warn.push(args);
    },
    error: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      calls.setCorrelationId.push(id ?? '');
    },
    getCorrelationId: () => calls.getCorrelationId,
    clearCorrelationId: () => {
      calls.clearCorrelationId++;
    },
    get debugCalls() {
      return calls.debug;
    },
    get warnCalls() {
      return calls.warn;
    },
    get errorCalls() {
      return calls.error;
    },
    get clearCorrelationIdCalls() {
      return calls.clearCorrelationId;
    },
    get setCorrelationIdCalls() {
      return calls.setCorrelationId;
    },
    get getCorrelationIdReturns() {
      return calls.getCorrelationId;
    },
    set getCorrelationIdReturns(v: string | undefined) {
      calls.getCorrelationId = v;
    },
  } as unknown as MockLogger;
}

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  const store: Record<string, any> = {
    ...values,
  };
  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
  };
}

function createMockAgentConfig() {
  let provider = 'mock-provider-orchestrator';
  const listeners: Array<() => void> = [];
  return {
    getAgent: () => ({} as any),
    getProvider: () => provider,
    getModel: () => 'mock-model',
    refreshAgent: () => {
      listeners.forEach((l) => l());
    },
    setProvider: (p: string) => {
      provider = p;
    },
    serviceTierOverrideForNextRequest: null as 'standard' | null,
    onRefresh: (listener: () => void) => {
      listeners.push(listener);
    },
  };
}

function createMockRunnerManager() {
  return {
    maxTurns: 20,
    getOrCreateRunner: (_providerId: string) => ({} as Runner),
  };
}

function createOrchestrator(overrides: Partial<AgentRunOrchestratorDeps> = {}): AgentRunOrchestrator {
  return new AgentRunOrchestrator({
    agentConfig: createMockAgentConfig() as any,
    runnerManager: createMockRunnerManager() as any,
    settings: createMockSettings() as any,
    logger: createMockLogger() as any,
    ...overrides,
  } as AgentRunOrchestratorDeps);
}

// ========== Set up providers for chaining tests ==========

beforeAll(() => {
  // Register a provider that supports conversation chaining
  registerProvider({
    id: 'mock-orch-chaining-true',
    label: 'Mock Orch Chaining True',
    createRunner: () => null as any,
    fetchModels: async () => [{ id: 'mock-model' }],
    capabilities: {
      supportsConversationChaining: true,
      supportsTracingControl: true,
    },
  });

  // Register a provider that does NOT support conversation chaining
  registerProvider({
    id: 'mock-orch-chaining-false',
    label: 'Mock Orch Chaining False',
    createRunner: () => null as any,
    fetchModels: async () => [{ id: 'mock-model' }],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
  });

  // Register openai for transport test
  registerProvider(
    {
      id: 'openai',
      label: 'Mock OpenAI for Orchestrator',
      createRunner: () => null as any,
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
      },
    },
    { allowOverride: true },
  );

  // Register codex for transport test
  registerProvider(
    {
      id: 'codex',
      label: 'Mock Codex for Orchestrator',
      createRunner: () => null as any,
      fetchModels: async () => [{ id: 'mock-model' }],
      capabilities: {
        supportsConversationChaining: true,
        supportsTracingControl: true,
      },
    },
    { allowOverride: true },
  );
});

// ========== Tests ==========

it('abort clears abort controller and correlation ID', () => {
  const logger = createMockLogger();
  const orchestrator = createOrchestrator({ logger: logger as any });

  // Calling abort with no active operation should not throw
  expect(() => orchestrator.abort()).not.toThrow();

  // Should log the abort event
  expect(logger.debugCalls.some((call: any[]) => call[1]?.eventType === 'stream.aborted')).toBe(true);
});

it('abort can be called multiple times', () => {
  const orchestrator = createOrchestrator();

  expect(() => orchestrator.abort()).not.toThrow();
  expect(() => orchestrator.abort()).not.toThrow();
  expect(() => orchestrator.abort()).not.toThrow();
});

it('supportsConversationChaining returns false for openai with http transport', () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  const settings = createMockSettings({ 'agent.transport': 'http' });
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    settings: settings as any,
  });

  expect(orchestrator.supportsConversationChaining()).toBe(false);
});

it('supportsConversationChaining returns false for codex with http transport', () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('codex');
  const settings = createMockSettings({ 'agent.transport': 'http' });
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    settings: settings as any,
  });

  expect(orchestrator.supportsConversationChaining()).toBe(false);
});

it('supportsConversationChaining returns true for providers that support it', () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('mock-orch-chaining-true');
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
  });

  expect(orchestrator.supportsConversationChaining()).toBe(true);
});

it('supportsConversationChaining returns false for providers that do not support it', () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('mock-orch-chaining-false');
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
  });

  expect(orchestrator.supportsConversationChaining()).toBe(false);
});

it('clearConversations resets chained delta state and logs', () => {
  const logger = createMockLogger();
  let refreshCalled = false;
  const agentConfig = {
    getAgent: () => ({} as any),
    getProvider: () => 'mock-orch-chaining-false',
    getModel: () => 'mock-model',
    refreshAgent: () => {
      refreshCalled = true;
    },
    serviceTierOverrideForNextRequest: null as 'standard' | null,
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    logger: logger as any,
  });

  orchestrator.clearConversations();

  expect(refreshCalled).toBe(true);
  expect(logger.debugCalls.some((call: any[]) => call[0] === 'Conversation and agent refreshed')).toBe(true);
});

it('clearConversations can be called multiple times', () => {
  const logger = createMockLogger();
  let refreshCount = 0;
  const agentConfig = {
    getAgent: () => ({} as any),
    getProvider: () => 'mock-orch-chaining-false',
    getModel: () => 'mock-model',
    refreshAgent: () => {
      refreshCount++;
    },
    serviceTierOverrideForNextRequest: null as 'standard' | null,
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    logger: logger as any,
  });

  expect(() => orchestrator.clearConversations()).not.toThrow();
  expect(() => orchestrator.clearConversations()).not.toThrow();
  expect(() => orchestrator.clearConversations()).not.toThrow();

  expect(refreshCount).toBe(3);
});

it('returns the established OpenAI projection while recording compatibility parity out of band', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  const observations: any[] = [];
  let filtered: any;
  const runner = {
    run: async (_agent: any, _input: any, options: any) => {
      filtered = options.callModelInputFilter({
        context: options.context,
        modelData: {
          input: [
            { role: 'user', type: 'message', content: 'before' },
            { role: 'user', type: 'message', content: 'now' },
          ],
        },
      });
      return { streamed: true };
    },
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
    openAIChainedInputParityObserver: { record: (observation) => observations.push(observation) },
  });
  const snapshot = Object.freeze({
    revision: 1,
    identity: 'history:test:1',
    history: Object.freeze([{ role: 'user', type: 'message', content: 'before' }]),
  });

  await expect(
    orchestrator.startStream('now', { previousResponseId: 'response-1', providerHistorySnapshot: snapshot as any }),
  ).resolves.toEqual({ streamed: true });

  expect(filtered.input).toEqual([{ role: 'user', type: 'message', content: 'now' }]);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ matches: true, compatibility: { prefix: { kind: 'match' } } });
  expect(observations[0].baseline.projectedModelData).toEqual(observations[0].compatibility.projectedModelData);
});

it('selects an exact-match OpenAI provider projection only for the frozen provider mode', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  const providerProjection = { input: [{ role: 'user', type: 'message', content: 'now' }] };
  let filtered: unknown;
  const projector = vi.fn(() => ({
    prefix: {
      kind: 'match' as const,
      snapshotIdentity: 'history:test:1',
      snapshotItemCount: 1,
      modelInputItemCount: 2,
      currentTurnSuffix: [{ role: 'user', type: 'message', content: 'now' }],
    },
    projectedModelData: providerProjection,
    projectedInput: providerProjection.input,
  }));
  const runner = {
    run: async (_agent: any, _input: any, options: any) => {
      filtered = options.callModelInputFilter({
        context: options.context,
        modelData: {
          input: [
            { role: 'user', type: 'message', content: 'before' },
            { role: 'user', type: 'message', content: 'now' },
          ],
        },
      });
      return {};
    },
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
    continuationProjectionMode: 'openai-provider',
    openAIChainedInputProjector: projector as any,
  });

  await orchestrator.startStream('now', {
    previousResponseId: 'response-1',
    providerHistorySnapshot: {
      revision: 1,
      identity: 'history:test:1',
      history: [{ role: 'user', type: 'message', content: 'before' }],
    },
  });

  expect(filtered).toBe(providerProjection);
  expect(projector).toHaveBeenCalledTimes(1);
});

it('keeps the baseline projection for legacy, mismatched, unequal, or failed provider compatibility', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  const baseline = { input: [{ role: 'user', type: 'message', content: 'now' }] };
  const cases = [
    {
      mode: 'legacy' as const,
      projector: () => ({ prefix: { kind: 'match' as const }, projectedModelData: baseline }),
    },
    {
      mode: 'openai-provider' as const,
      projector: () => ({ prefix: { kind: 'mismatch' as const }, projectedModelData: baseline }),
    },
    {
      mode: 'openai-provider' as const,
      projector: () => ({ prefix: { kind: 'match' as const }, projectedModelData: { input: [] } }),
    },
    {
      mode: 'openai-provider' as const,
      projector: () => {
        throw new Error('projection failed');
      },
    },
  ];

  for (const { mode, projector } of cases) {
    let filtered: any;
    const runner = {
      run: async (_agent: any, _input: any, options: any) => {
        filtered = options.callModelInputFilter({
          context: options.context,
          modelData: {
            input: [
              { role: 'user', type: 'message', content: 'before' },
              { role: 'user', type: 'message', content: 'now' },
            ],
          },
        });
        return {};
      },
    };
    const orchestrator = createOrchestrator({
      agentConfig: agentConfig as any,
      runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
      continuationProjectionMode: mode,
      openAIChainedInputProjector: projector as any,
    });

    await orchestrator.startStream('now', {
      previousResponseId: 'response-1',
      providerHistorySnapshot: {
        revision: 1,
        identity: 'history:test:1',
        history: [{ role: 'user', type: 'message', content: 'before' }],
      },
    });
    expect(filtered).not.toBe(baseline);
    expect(filtered).toEqual(baseline);
  }
});

it('keeps the established projection and executes the request when the parity observer throws', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  let filtered: any;
  let runCount = 0;
  const runner = {
    run: async (_agent: any, _input: any, options: any) => {
      runCount++;
      filtered = options.callModelInputFilter({
        context: options.context,
        modelData: {
          input: [
            { role: 'user', type: 'message', content: 'before' },
            { role: 'user', type: 'message', content: 'now' },
          ],
        },
      });
      return { streamed: true };
    },
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
    openAIChainedInputParityObserver: {
      record: () => {
        throw new Error('observer failure');
      },
    },
  });
  const snapshot = Object.freeze({
    revision: 1,
    identity: 'history:test:1',
    history: Object.freeze([{ role: 'user', type: 'message', content: 'before' }]),
  });

  await expect(
    orchestrator.startStream('now', { previousResponseId: 'response-1', providerHistorySnapshot: snapshot as any }),
  ).resolves.toEqual({ streamed: true });

  expect(runCount).toBe(1);
  expect(filtered.input).toEqual([{ role: 'user', type: 'message', content: 'now' }]);
});

it('keeps baseline chained-input errors as throws while parity records a structured error', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('openai');
  const observations: any[] = [];
  const runner = {
    run: async (_agent: any, _input: any, options: any) =>
      options.callModelInputFilter({
        context: options.context,
        modelData: { input: [] },
      }),
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
    openAIChainedInputParityObserver: { record: (observation) => observations.push(observation) },
  });

  await expect(
    orchestrator.startStream('now', {
      previousResponseId: 'response-1',
      toolResultCallIds: ['missing'],
      providerHistorySnapshot: { revision: 1, identity: 'history:test:1', history: [] },
    }),
  ).rejects.toMatchObject({ name: 'MissingChainedToolOutputError', callIds: ['missing'] });

  expect(observations).toMatchObject([{ baseline: { error: { name: 'MissingChainedToolOutputError' } } }]);
  expect(observations[0].compatibility.error).toMatchObject({
    name: 'MissingChainedToolOutputError',
    callIds: ['missing'],
  });
});

it('does not invoke the OpenAI parity observer for Codex', async () => {
  const agentConfig = createMockAgentConfig();
  agentConfig.setProvider('codex');
  const observations: any[] = [];
  const projector = vi.fn();
  const runner = {
    run: async (_agent: any, _input: any, options: any) => {
      options.callModelInputFilter({
        context: options.context,
        modelData: { input: [{ role: 'user', content: 'now' }] },
      });
      return {};
    },
  };
  const orchestrator = createOrchestrator({
    agentConfig: agentConfig as any,
    runnerManager: { maxTurns: 20, getOrCreateRunner: () => runner } as any,
    continuationProjectionMode: 'openai-provider',
    openAIChainedInputParityObserver: { record: (observation) => observations.push(observation) },
    openAIChainedInputProjector: projector as any,
  });

  await orchestrator.startStream('now', {
    previousResponseId: 'response-1',
    providerHistorySnapshot: { revision: 0, identity: 'history:test:0', history: [] },
  });

  expect(observations).toEqual([]);
  expect(projector).not.toHaveBeenCalled();
});
