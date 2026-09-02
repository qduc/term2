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
        'agent.model': 'mock-model',
        'agent.provider': providerId,
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
        'agent.provider': 'openai',
        'agent.model': 'gpt-4o',
        'agent.efficientModel': 'gpt-4o-mini',
        'agent.mentorModel': 'gpt-4o',
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
});
