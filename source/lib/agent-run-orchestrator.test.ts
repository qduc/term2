import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
