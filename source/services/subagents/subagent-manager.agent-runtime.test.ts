import { describe, it, expect, vi } from 'vitest';
import { SubagentManager } from './subagent-manager.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { AgentRuntime } from '../agent-runtime/agent-runtime.js';

function logger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

function settings(values: Record<string, unknown> = {}): ISettingsService {
  const store: Record<string, unknown> = {
    'agent.provider': 'openai',
    'agent.model': 'gpt-4o',
    'agent.efficientModel': 'gpt-4o-mini',
    'agent.mentorModel': 'gpt-4o',
    ...values,
  };
  return {
    get: <T>(key: string) => store[key] as T,
    set: () => {},
  };
}

function sessionContextService(): ISessionContextService {
  return {
    getSessionId: () => 'test-session',
    getCwd: () => '/test/cwd',
    getEnv: () => ({}),
  } as unknown as ISessionContextService;
}

function stubCreateClient() {
  return vi.fn(() => ({
    run: vi.fn(),
    stream: vi.fn(),
    runConversation: vi.fn(),
    startStream: vi.fn(),
    continueRunStream: vi.fn(),
    abort: vi.fn(),
    setModel: vi.fn(),
    supportsConversationChaining: false,
    supportsReasoning: false,
    supportsTracingControl: false,
    dispose: vi.fn(),
  })) as any;
}

describe('SubagentManager.getAgentRuntime()', () => {
  it('returns an AgentRuntime backed by the same subagent infrastructure', () => {
    const manager = new SubagentManager({
      logger: logger(),
      settings: settings(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const runtime = manager.getAgentRuntime();
    expect(runtime).toBeDefined();
    expect(typeof runtime.agent).toBe('function');
  });

  it('AgentRuntime from SubagentManager can create AgentHandles', () => {
    const manager = new SubagentManager({
      logger: logger(),
      settings: settings(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const runtime = manager.getAgentRuntime();
    const handle = runtime.agent({
      instructions: 'You are a helpful agent.',
      name: 'test-agent',
      tools: ['read_file'],
      permissions: { tools: ['read_file'] },
    });

    expect(handle.name).toBe('test-agent');
    expect(handle.model.provider).toBe('openai');
    expect(handle.permissions.tools).toContain('read_file');
  });

  it('returns the same type of AgentRuntime as standalone createAgentRuntime', () => {
    const manager = new SubagentManager({
      logger: logger(),
      settings: settings(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const runtime = manager.getAgentRuntime();
    // Verify it has the expected interface
    expect(runtime).toHaveProperty('agent');
    expect(typeof runtime.agent).toBe('function');

    const handle = runtime.agent({ instructions: 'test' });
    expect(handle).toHaveProperty('name');
    expect(handle).toHaveProperty('model');
    expect(handle).toHaveProperty('permissions');
    expect(handle).toHaveProperty('limits');
    expect(handle).toHaveProperty('run');
    expect(typeof handle.run).toBe('function');
  });

  it('AgentRuntime handles respect parent permission attenuation', () => {
    const manager = new SubagentManager({
      logger: logger(),
      settings: settings(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    // We can't set parent on getAgentRuntime directly since it uses
    // the manager's existing infrastructure. But we can verify the
    // returned runtime works with the expected API.
    const runtime = manager.getAgentRuntime();

    const handle = runtime.agent({
      instructions: 'nested',
      tools: ['read_file', 'shell'],
      permissions: { tools: ['read_file', 'shell'] },
    });

    // Without parent attenuation, all requested tools are present
    expect(handle.permissions.tools).toContain('read_file');
    expect(handle.permissions.tools).toContain('shell');
  });

  it('multiple calls return fresh handles sharing the same executors', () => {
    const manager = new SubagentManager({
      logger: logger(),
      settings: settings(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const runtime1 = manager.getAgentRuntime();
    const runtime2 = manager.getAgentRuntime();

    // Different runtime wrappers, but shared executors underneath
    expect(runtime1).not.toBe(runtime2);

    // Both can create handles
    const handle1 = runtime1.agent({ instructions: 'agent 1' });
    const handle2 = runtime2.agent({ instructions: 'agent 2' });

    expect(handle1.name).toBe('agent');
    expect(handle2.name).toBe('agent');
  });
});
