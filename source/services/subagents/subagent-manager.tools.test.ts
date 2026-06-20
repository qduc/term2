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
import { ModelBehaviorError } from '@openai/agents';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

it('subagent tool definitions conditional registration for search tools', async () => {
  let workerAgentShellTrue: any = null;
  let workerAgentShellFalse: any = null;

  const providerIdShellTrue = registerTestProvider({
    label: 'Mock Tool Test Provider Shell True',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          workerAgentShellTrue = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  const providerIdShellFalse = registerTestProvider({
    label: 'Mock Tool Test Provider Shell False',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          workerAgentShellFalse = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-4o' }],
  });

  // 1. Model: gpt-5 (searchViaShell is true by default), canRunShell: true (from worker.md)
  // Explorer/worker tools should NOT contain dedicated search tools: grep and find_files.
  const managerShellTrue = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerIdShellTrue,
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellTrue.run({ role: 'worker', task: 'some task' });

  expect(workerAgentShellTrue).toBeTruthy();
  const toolNamesShellTrue: string[] = workerAgentShellTrue.tools.map((tool: any) => tool.name);
  expect(toolNamesShellTrue.includes('grep')).toBe(false);
  expect(toolNamesShellTrue.includes('find_files')).toBe(false);
  expect(toolNamesShellTrue.includes('shell')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('Registered tools:')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('`fd` for file search')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('Use `grep` to search')).toBe(false);
  expect(workerAgentShellTrue.instructions.includes('Use `find_files` to locate')).toBe(false);
  expect(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools')).toBe(
    false,
  );

  // 2. Model: gpt-4o (searchViaShell is false by default), canRunShell: true
  // Tools should include dedicated grep and find_files.
  const managerShellFalse = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-4o',
      'agent.provider': providerIdShellFalse,
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellFalse.run({ role: 'worker', task: 'some task' });

  expect(workerAgentShellFalse).toBeTruthy();
  const toolNamesShellFalse: string[] = workerAgentShellFalse.tools.map((tool: any) => tool.name);
  expect(toolNamesShellFalse.includes('grep')).toBe(true);
  expect(toolNamesShellFalse.includes('find_files')).toBe(true);
  expect(toolNamesShellFalse.includes('shell')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('For workspace search, use the dedicated search tools')).toBe(
    true,
  );
  expect(workerAgentShellFalse.instructions.includes('`grep`')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('`find_files`')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('use `shell` with commands like `rg`')).toBe(false);

  // 3. Model: gpt-5 with searchViaShell explicitly disabled still keeps dedicated search tools.
  const managerShellOff = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerIdShellTrue,
      'app.searchViaShell': 'off',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellOff.run({ role: 'worker', task: 'some task' });

  const toolNamesShellOff: string[] = workerAgentShellTrue.tools.map((tool: any) => tool.name);
  expect(toolNamesShellOff.includes('grep')).toBe(true);
  expect(toolNamesShellOff.includes('find_files')).toBe(true);
  expect(toolNamesShellOff.includes('shell')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`')).toBe(false);
});

it('explorer uses shell search when available and researcher keeps dedicated search tools', async () => {
  let explorerAgent: any = null;
  let researcherAgent: any = null;

  const providerIdExplorer = registerTestProvider({
    label: 'Mock Tool Test Provider Explorer Shell',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          explorerAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  const providerIdResearcher = registerTestProvider({
    label: 'Mock Tool Test Provider Researcher Dedicated',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          researcherAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  await new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerIdExplorer,
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  }).run({ role: 'explorer', task: 'find files' });

  await new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': providerIdResearcher,
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  }).run({ role: 'researcher', task: 'research files' });

  expect(explorerAgent).toBeTruthy();
  let toolNames: string[] = explorerAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('shell')).toBe(true);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('find_files')).toBe(false);
  expect(explorerAgent.instructions.includes('For workspace search, use `shell` with commands like `rg`')).toBe(true);
  expect(explorerAgent.instructions.includes('For workspace search, use the dedicated search tools')).toBe(false);

  expect(researcherAgent).toBeTruthy();
  toolNames = researcherAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('shell')).toBe(false);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('find_files')).toBe(true);
  expect(researcherAgent.instructions.includes('For workspace search, use the dedicated search tools')).toBe(true);
  expect(researcherAgent.instructions.includes('use `shell` with commands like `rg`')).toBe(false);
});

it('remote execution disables code-context tools and guidance', async () => {
  let remoteAgent: any = null;

  const providerId = registerTestProvider({
    label: 'Mock Tool Test Provider Remote',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          remoteAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-4o' }],
  });

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-4o',
      'agent.provider': providerId,
    }),
    executionContext: {
      getCwd: () => '/tmp/remote-workspace',
      isRemote: () => true,
      getSSHService: () => undefined,
    } as any,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'explorer', task: 'inspect remote files' });

  expect(remoteAgent).toBeTruthy();
  const toolNames: string[] = remoteAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('read_code_outline')).toBe(false);
  expect(toolNames.includes('code_context_search')).toBe(false);
  expect(remoteAgent.instructions.includes('Code-context tools are not available in this run.')).toBe(true);
  expect(remoteAgent.instructions.includes('For code structure and symbol context, use:')).toBe(false);
});
