import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
  wrapErrorAsAgentStream,
  getAgentTool,
  ROLE_MENTOR,
  ROLE_EXPLORER,
  ROLE_WORKER,
  ROLE_RESEARCHER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '../../contracts/model-errors.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

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

it('execution subagents select subagent-safe model-family prompts and append role instructions', async () => {
  let constructedAgentExplorer: any = null;
  let constructedAgentWorker: any = null;
  let constructedAgentResearcher: any = null;

  const providerIdCodex = registerTestProvider({
    label: 'Mock Prompt Test Provider GPT-5 Codex',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          constructedAgentExplorer = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5-codex' }],
  });

  const providerIdClaude = registerTestProvider({
    label: 'Mock Prompt Test Provider Claude 3 Sonnet',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          constructedAgentWorker = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'claude-3-sonnet' }],
  });

  const providerIdGpt5 = registerTestProvider({
    label: 'Mock Prompt Test Provider GPT-5 Modern',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          constructedAgentResearcher = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  // 1. Run explorer subagent with gpt-5-codex
  const managerExplorer = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5-codex',
      'agent.provider': providerIdCodex,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerExplorer.run({ role: 'explorer', task: 'explorer task' });

  expect(constructedAgentExplorer).toBeTruthy();
  expect(constructedAgentExplorer.instructions.includes('nested Codex-family subagent')).toBe(true);
  expect(constructedAgentExplorer.instructions.includes('You are an explorer subagent.')).toBe(true);
  expect(constructedAgentExplorer.instructions.includes('## Worktree Hygiene')).toBe(true);
  expect(constructedAgentExplorer.instructions.includes('## Available Tool Guidance')).toBe(true);

  const codexIdx = constructedAgentExplorer.instructions.indexOf('nested Codex-family subagent');
  const explorerIdx = constructedAgentExplorer.instructions.indexOf('You are an explorer subagent');
  expect(codexIdx < explorerIdx).toBe(true);

  // 2. Run worker subagent with claude-3-sonnet
  const managerWorker = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'claude-3-sonnet',
      'agent.provider': providerIdClaude,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerWorker.run({ role: 'worker', task: 'worker task' });

  expect(constructedAgentWorker).toBeTruthy();
  expect(constructedAgentWorker.instructions.includes('nested Anthropic-family subagent')).toBe(true);
  expect(constructedAgentWorker.instructions.includes('You are a worker subagent.')).toBe(true);

  const sonnetIdx = constructedAgentWorker.instructions.indexOf('nested Anthropic-family subagent');
  const workerIdx = constructedAgentWorker.instructions.indexOf('You are a worker subagent');
  expect(sonnetIdx < workerIdx).toBe(true);

  const managerResearcher = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerIdGpt5,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerResearcher.run({ role: 'researcher', task: 'research task' });

  expect(constructedAgentResearcher).toBeTruthy();
  expect(constructedAgentResearcher.instructions.includes('nested GPT-5-family subagent')).toBe(true);
  expect(constructedAgentResearcher.instructions.includes('You are a researcher subagent.')).toBe(true);
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
