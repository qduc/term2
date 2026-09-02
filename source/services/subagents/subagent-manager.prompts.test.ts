import { it, expect } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
  wrapResultAsAgentStream,
} from './test-helpers/subagent-manager-fixtures.js';

it('subagent direct streamed model preserves the final response contract', async () => {
  const providerId = registerTestProvider({
    label: 'Mock Subagent Direct Provider',
    createStreamedModel: () => ({
      async *stream() {
        yield {
          type: 'completion',
          responseId: 'subagent-direct',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    }),
    fetchModels: async () => [{ id: 'mock-model' }],
  });
  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({ 'agent.model': 'mock-model', 'agent.provider': providerId }),
    sessionContextService: createSessionContextService() as any,
  });
  const result = await manager.run({ role: 'explorer', task: 'mock task' });
  expect(result.status).toBe('completed');
  expect(result.finalText).toBe('done');
});

interface PromptCase {
  title: string;
  model: string;
  role: 'explorer' | 'worker';
  /** Family marker the model-family base profile injects. */
  familyMarker: string;
  /** Role opener the role body contributes. */
  roleOpener: string;
}

// Execution subagents compose a model-family base profile first and append the
// role body, so the family marker must precede the role opener for every
// (family, role) pair below.
const promptCases: PromptCase[] = [
  {
    title: 'codex-family explorer',
    model: 'gpt-5-codex',
    role: 'explorer',
    familyMarker: 'nested Codex-family subagent',
    roleOpener: 'You are an explorer subagent.',
  },
  {
    title: 'anthropic-family worker',
    model: 'claude-3-sonnet',
    role: 'worker',
    familyMarker: 'nested Anthropic-family subagent',
    roleOpener: 'You are a worker subagent.',
  },
  {
    title: 'gpt-5-family explorer',
    model: 'gpt-5',
    role: 'explorer',
    familyMarker: 'nested GPT-5-family subagent',
    roleOpener: 'You are an explorer subagent.',
  },
];

it.each(promptCases)('execution subagent prompt selects the $title base profile and role instructions', async (c) => {
  let constructedAgent: any = null;

  const providerId = registerTestProvider({
    label: `Mock Prompt Test Provider ${c.model}`,
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          constructedAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: c.model }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': c.model,
      'agent.provider': providerId,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: c.role, task: `${c.role} task` });

  expect(constructedAgent).toBeTruthy();
  expect(constructedAgent.instructions.includes(c.familyMarker)).toBe(true);
  expect(constructedAgent.instructions.includes(c.roleOpener)).toBe(true);
  expect(constructedAgent.instructions.includes('## Worktree Hygiene')).toBe(true);
  expect(constructedAgent.instructions.includes('## Available Tool Guidance')).toBe(true);

  const familyIdx = constructedAgent.instructions.indexOf(c.familyMarker);
  const roleIdx = constructedAgent.instructions.indexOf(c.roleOpener);
  expect(familyIdx < roleIdx).toBe(true);
});

it('execution subagent prompts exclude top-level-only prompt content', async () => {
  let constructedAgent: any = null;

  const providerId = registerTestProvider({
    label: 'Mock Top Level Exclusion Provider',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          constructedAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5-codex' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5-codex',
      'agent.provider': providerId,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'worker', task: 'worker task' });

  expect(constructedAgent).toBeTruthy();
  expect(constructedAgent.instructions.includes('commentary channel')).toBe(false);
  expect(constructedAgent.instructions.includes('final channel')).toBe(false);
  expect(constructedAgent.instructions.includes('Intermediary updates')).toBe(false);
  expect(constructedAgent.instructions.includes('Plan Mode Workflow')).toBe(false);
  expect(constructedAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.')).toBe(false);
});

it('mentor subagent is NOT affected by prompt profiles', async () => {
  let mentorAgent: any = null;

  const providerId = registerTestProvider({
    label: 'Mock Prompt Test Provider Mentor',
    createStreamedModel: () => ({
      async *stream(request: any) {
        mentorAgent = { instructions: request.instructions };
        yield {
          type: 'completion',
          responseId: 'mentor-response',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    }),
    fetchModels: async () => [{ id: 'gpt-5-codex' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'main-model',
      'agent.provider': providerId,
      'agent.mentorModel': 'gpt-5-codex',
      'agent.mentorProvider': providerId,
      'app.mentorMode': false,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'mentor', task: 'advise me' });

  expect(mentorAgent).toBeTruthy();
  expect(mentorAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.')).toBe(false);
  expect(mentorAgent.instructions.includes('nested Codex-family subagent')).toBe(false);
  expect(mentorAgent.instructions.includes('## Available Tool Guidance')).toBe(false);
  expect(mentorAgent.instructions.includes('## Worktree Hygiene')).toBe(false);
  expect(mentorAgent.instructions.includes('You are a strategic engineering mentor')).toBe(true);
});
