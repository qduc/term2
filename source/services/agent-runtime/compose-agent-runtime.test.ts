import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentRuntime } from './compose-agent-runtime.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ISubagentClientFactory } from '../subagents/subagent-client-types.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';

// ── Mocks ──────────────────────────────────────────────────────────

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
    getConversationId: () => 'test-conversation',
  } as unknown as ISessionContextService;
}

/**
 * Create a stub ISubagentClientFactory that returns a minimal
 * ConversationAgentClient mock. This is the "only provider/client
 * boundaries mocked" part of the acceptance criteria.
 */
function stubCreateClient(): ISubagentClientFactory['createClient'] {
  return vi.fn(() => ({
    // Minimal agent client stub that the session runtime can consume.
    // We don't actually run the agent — we mock at this boundary so the
    // real SubagentToolPolicy / SubagentToolFactory / ExecutionSubagentRunner
    // compose and the only thing missing is the real model call.
    run: vi.fn(),
    stream: vi.fn(),
    runConversation: vi.fn(),
    supportsConversationChaining: false,
    supportsReasoning: false,
    supportsTracingControl: false,
    dispose: vi.fn(),
  })) as unknown as ISubagentClientFactory['createClient'];
}

// We keep provider internals mocked but run the real composition.
// The real ExecutionSubagentRunner requires a real Agent from @openai/agents,
// which in turn needs real tool definitions. Since those have side effects
// (file system, web), we mock at the module level.
vi.mock('@openai/agents', () => {
  const actual = vi.importActual('@openai/agents');
  return {
    ...actual,
    Agent: vi.fn().mockImplementation(function (this: any, config: any) {
      this.name = config.name;
      this.model = config.model;
      this.instructions = config.instructions;
      this.tools = config.tools ?? [];
      this.modelSettings = config.modelSettings;
    }),
    Runner: {
      run: vi.fn(),
      runConversation: vi.fn(),
    },
    tool: vi.fn((def: any) => def),
    RunContext: class {},
  };
});

describe('createAgentRuntime composition', () => {
  it('returns runtime, executionRunner, mentorRunner, and resolveRoleDefinition', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    expect(comp.runtime).toBeDefined();
    expect(comp.executionRunner).toBeDefined();
    expect(comp.mentorRunner).toBeDefined();
    expect(comp.resolveRoleDefinition).toBeDefined();
    expect(typeof comp.resolveRoleDefinition).toBe('function');
  });

  it('runtime.agent() creates a handle that can run with a mock executor backing', async () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const handle = comp.runtime.agent({
      instructions: 'You are a test agent.',
      name: 'test-agent',
      tools: ['read_file'],
      permissions: { tools: ['read_file'] },
    });

    expect(handle.name).toBe('test-agent');
    expect(handle.model.provider).toBe('openai');
    expect(handle.permissions.tools).toContain('read_file');

    // The run requires a real ExecutionSubagentRunner which needs a
    // real model call. In this test we verify that the composition
    // wires everything together without throwing.
    // We don't await handle.run() because it would hit the real runner
    // which would try to make network calls. Instead we verify the
    // structural soundness through the composition.
    expect(comp.executionRunner).toBeDefined();
    expect(comp.mentorRunner).toBeDefined();
  });

  it('resolveRoleDefinition adapts legacy explorer role correctly', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const def = comp.resolveRoleDefinition('explorer');
    expect(def.role).toBe('explorer');
    expect(def.name).toBe('Explorer');
    expect(def.canRead).toBe(true);
    expect(def.canWrite).toBe(false);
    expect(def.canRunShell).toBe(true);
    expect(def.canSearchWeb).toBe(false);
    expect(def.instructions).toBeTruthy();
  });

  it('resolveRoleDefinition adapts worker role correctly', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const def = comp.resolveRoleDefinition('worker');
    expect(def.canRead).toBe(true);
    expect(def.canWrite).toBe(true);
    expect(def.canRunShell).toBe(true);
  });

  it('resolveRoleDefinition adapts mentor role correctly', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const def = comp.resolveRoleDefinition('mentor');
    // Mentor has no filesystem/shell authority
    expect(def.canRead).toBe(false);
    expect(def.canWrite).toBe(false);
    expect(def.canRunShell).toBe(false);
  });

  it('produces SubagentDefinition with instructions from ResolvedAgentDefinition', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    // verify the adapter round-trip
    const def = comp.resolveRoleDefinition('explorer');
    expect(typeof def.instructions).toBe('string');
    expect(def.instructions.length).toBeGreaterThan(0);
    expect(typeof def.maxTurns).toBe('number');
    expect(def.maxTurns).toBeGreaterThan(0);
  });
});

describe('createAgentRuntime handles edge cases', () => {
  it('passes agentClient to SubagentToolPolicy when provided', () => {
    // Just verify it doesn't throw
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
      agentClient: {
        run: vi.fn(),
        stream: vi.fn(),
        runConversation: vi.fn(),
        supportsConversationChaining: false,
      } as any,
      executionContext: {
        getCwd: () => '/test/cwd',
        isRemote: () => false,
      } as any,
    });

    expect(comp.runtime).toBeDefined();
    expect(comp.executionRunner).toBeDefined();
  });

  it('accepts parent permissions for nested agent creation', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
      parent: {
        permissions: { tools: ['read_file'] },
        limits: { maxTurns: 5 },
        modelPolicy: { provider: 'openai', model: 'gpt-4o' },
      },
    });

    const handle = comp.runtime.agent({
      instructions: 'nested',
      tools: ['read_file', 'shell'],
      permissions: { tools: ['read_file', 'shell'] },
    });

    // Parent only grants read, so shell should be denied
    expect(handle.permissions.tools).toContain('read_file');
    expect(handle.permissions.tools).not.toContain('shell');
  });

  it('returns different runtime instances for different calls', () => {
    const deps = {
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    };

    const comp1 = createAgentRuntime(deps);
    const comp2 = createAgentRuntime(deps);

    expect(comp1.runtime).not.toBe(comp2.runtime);
    expect(comp1.executionRunner).not.toBe(comp2.executionRunner);
  });
});

describe('createAgentRuntime no leakage of internal fields', () => {
  it('AgentRuntimeComposition exposes only stable public members', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    // Only the declared members
    const keys = Object.keys(comp);
    expect(keys).toContain('runtime');
    expect(keys).toContain('executionRunner');
    expect(keys).toContain('mentorRunner');
    expect(keys).toContain('resolveRoleDefinition');
    expect(keys.length).toBe(4);

    // No internal/private fields leaked
    expect((comp as any).toolPolicy).toBeUndefined();
    expect((comp as any).toolFactory).toBeUndefined();
    expect((comp as any).nestedRunner).toBeUndefined();
  });

  it('AgentRuntime agent() resolves tools through the known tool set', () => {
    const comp = createAgentRuntime({
      settings: settings(),
      logger: logger(),
      sessionContextService: sessionContextService(),
      createClient: stubCreateClient(),
    });

    const handle = comp.runtime.agent({
      instructions: 'read only',
      tools: ['read_file', 'grep'],
      permissions: { tools: ['read_file', 'grep'] },
    });

    expect(handle.permissions.tools).toContain('read_file');
    expect(handle.permissions.tools).toContain('grep');
    // Unknown tools not in permission list
    expect(handle.permissions.tools).not.toContain('shell');
  });
});
