import { describe, expect, it } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
  wrapResultAsAgentStream,
} from './test-helpers/subagent-manager-fixtures.js';

describe('SubagentManager.getAgentRuntime()', () => {
  it('delegates handle execution through the manager runtime and resolves a run result', async () => {
    let executedAgent: any = null;

    const providerId = registerTestProvider({
      label: 'Mock Agent Runtime Delegation Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (agent: any) {
            executedAgent = agent;
            const result = { status: 'completed', finalOutput: 'delegated output', history: [], messages: [] };
            yield* wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.modelSelection': { model: 'mock-model', provider: providerId },
      }),
      sessionContextService: createSessionContextService() as any,
    });

    const handle = manager.getAgentRuntime().agent({
      name: 'delegated-agent',
      instructions: 'Follow the delegated instructions.',
      tools: ['read_file'],
      permissions: { tools: ['read_file'] },
    });

    const result = await handle.run({ task: 'Summarize the target file.' });

    // The handle ran through the manager's own ExecutionSubagentRunner: the
    // transient client came from the manager's provider and carried the handle's
    // composed instructions, task, and narrowed (read-only) tool surface.
    expect(result.status).toBe('completed');
    expect(result.output).toBe('delegated output');
    expect(executedAgent).toBeTruthy();
    expect(executedAgent.instructions.includes('Follow the delegated instructions.')).toBe(true);
    expect(executedAgent.instructions.includes('Summarize the target file.')).toBe(true);
    const toolNames: string[] = executedAgent.tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('shell');
  });

  it('returns fresh runtime wrappers that share the same executors', () => {
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.modelSelection': { model: 'gpt-4o', provider: 'openai' },
        'agent.cheapModel': [{ model: 'gpt-4o-mini', provider: 'openai' }],
        'agent.mentorPool': [{ model: 'gpt-4o', provider: 'openai' }],
      }),
      sessionContextService: createSessionContextService() as any,
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

  it('executes an asynchronous dynamic spec through the existing runner with narrowed tools and budget', async () => {
    let executedAgent: any = null;
    const providerId = registerTestProvider({
      label: 'Mock Dynamic Agent Spec Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (agent: any) {
            executedAgent = agent;
            yield* wrapResultAsAgentStream({
              status: 'completed',
              finalOutput: 'dynamic output',
              history: [],
              messages: [],
            });
          },
        } as any),
      fetchModels: async () => [{ id: 'dynamic-model' }],
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({ 'agent.modelSelection': { model: 'dynamic-model', provider: providerId  }}),
      sessionContextService: createSessionContextService() as any,
    });

    const handle = manager.startRunAsync({
      role: 'agent',
      task: 'Inspect the requested file.',
      agentSpec: {
        goal: 'Inspect the requested file.',
        context: { file: 'source/example.ts' },
        tools: ['read_file'],
        constraints: ['Do not edit files'],
        doneWhen: 'Return a concise evidence-backed summary',
        budget: { maxTurns: 3, maxTokens: 10_000 },
      },
    });
    const result = await manager.getRunResult(handle.runId);

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('dynamic output');
    expect(executedAgent.instructions).toContain('Do not edit files');
    expect(executedAgent.instructions).toContain('Return a concise evidence-backed summary');
    expect(executedAgent.instructions).toContain('source/example.ts');
    expect(executedAgent.maxTokens).toBe(10_000);
    const toolNames: string[] = executedAgent.tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).not.toContain('shell');
  });

  it('executes a host-resolved definition without requiring a raw AgentSpec', async () => {
    let executedAgent: any = null;
    const providerId = registerTestProvider({
      label: 'Mock Pre-Resolved Agent Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (agent: any) {
            executedAgent = agent;
            yield* wrapResultAsAgentStream({
              status: 'completed',
              finalOutput: 'pre-resolved output',
              history: [],
              messages: [],
            });
          },
        } as any),
      fetchModels: async () => [{ id: 'pre-resolved-model' }],
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({ 'agent.modelSelection': { model: 'pre-resolved-model', provider: providerId  }}),
      sessionContextService: createSessionContextService() as any,
    });
    const resolvedDefinition = {
      role: 'agent',
      name: 'pre-resolved-agent',
      instructions: 'Use the host-resolved instructions.',
      canRead: true,
      canWrite: false,
      canSearchWeb: false,
      canRunShell: false,
      maxTurns: 3,
      model: 'pre-resolved-model',
      provider: providerId,
      reasoningEffort: 'default',
      tools: ['read_file'],
    };

    const result = await manager.runAsTool({
      role: 'agent',
      task: 'Inspect the approved file.',
      resolvedDefinition,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('pre-resolved output');
    expect(executedAgent.instructions).toContain('Use the host-resolved instructions.');
    expect(executedAgent.tools.map((tool: any) => tool.name)).toEqual(['read_file']);
  });

  it('rejects generic specs that request capabilities outside their permission allowlist', () => {
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({ 'agent.modelSelection': { model: 'gpt-4o' , provider: 'openai' }}),
      sessionContextService: createSessionContextService() as any,
    });

    expect(() =>
      manager.startRunAsync({
        role: 'agent',
        task: 'do not run',
        agentSpec: {
          goal: 'Try to run shell',
          tools: ['shell'],
          permissions: { tools: ['read_file'] },
        },
      }),
    ).toThrow(/not authorized/i);
  });

  it('rejects unsupported delegated budget fields and invalid integer budgets', () => {
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({ 'agent.modelSelection': { model: 'gpt-4o' , provider: 'openai' }}),
      sessionContextService: createSessionContextService() as any,
    });
    const request = (budget: any) =>
      manager.startRunAsync({ role: 'agent', task: 'inspect', agentSpec: { goal: 'inspect', budget } });

    expect(() => request({ timeoutMs: 1_000 })).toThrow(/Unsupported AgentSpec budget fields.*timeoutMs/);
    expect(() => request({ maxDepth: 2 })).toThrow(/Unsupported AgentSpec budget fields.*maxDepth/);
    expect(() => request({ maxTurns: 0 })).toThrow(/budget.maxTurns must be a positive integer/);
    expect(() => request({ maxTokens: 1.5 })).toThrow(/budget.maxTokens must be a positive integer/);
  });

  it('runs write-capable generic specs through the foreground nested approval path', async () => {
    let executedAgent: any = null;
    const providerId = registerTestProvider({
      label: 'Mock Foreground Generic Agent Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (agent: any) {
            executedAgent = agent;
            yield* wrapResultAsAgentStream({ status: 'completed', finalOutput: 'ready', history: [], messages: [] });
          },
        } as any),
      fetchModels: async () => [{ id: 'foreground-generic' }],
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({ 'agent.modelSelection': { model: 'foreground-generic', provider: providerId  }}),
      sessionContextService: createSessionContextService() as any,
    });

    const result = await manager.runAsTool({
      role: 'agent',
      task: 'Prepare an implementation',
      agentSpec: {
        goal: 'Prepare an implementation',
        tools: ['create_file'],
        permissions: { tools: ['create_file'] },
      },
    });

    expect(result.status).toBe('completed');
    expect(executedAgent.tools.map((tool: any) => tool.name)).toContain('create_file');
    expect(executedAgent.tools.map((tool: any) => tool.name)).not.toContain('read_file');
  });
});
