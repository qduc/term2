import { it, expect } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
  wrapResultAsAgentStream,
} from './test-helpers/subagent-manager-fixtures.js';

interface ToolCase {
  title: string;
  model: string;
  role: 'worker' | 'explorer';
  searchViaShell: 'auto' | 'off';
  grep: boolean;
  glob: boolean;
  shell: boolean;
  /** Guidance strings that must appear in the composed instructions. */
  include: string[];
  /** Guidance strings that must not appear. */
  exclude: string[];
}

// One configuration matrix for the conditional search-tool registration across
// the model default (gpt-5 prefers shell search, gpt-4o does not), the explicit
// app.searchViaShell override, and the role-dependent tool surface.
const toolCases: ToolCase[] = [
  {
    title: 'gpt-5 worker with searchViaShell auto registers shell search instead of dedicated search tools',
    model: 'gpt-5',
    role: 'worker',
    searchViaShell: 'auto',
    grep: false,
    glob: false,
    shell: true,
    include: ['Registered tools:', 'use `shell` with commands like `rg`', '`fd` for file search'],
    exclude: ['Use `grep` to search', 'Use `glob` to locate', 'For workspace search, use the dedicated search tools'],
  },
  {
    title: 'gpt-4o worker with searchViaShell auto keeps dedicated search tools',
    model: 'gpt-4o',
    role: 'worker',
    searchViaShell: 'auto',
    grep: true,
    glob: true,
    shell: true,
    include: ['For workspace search, use the dedicated search tools', '`grep`', '`glob`'],
    exclude: ['use `shell` with commands like `rg`'],
  },
  {
    title: 'gpt-5 worker with searchViaShell off keeps dedicated search tools',
    model: 'gpt-5',
    role: 'worker',
    searchViaShell: 'off',
    grep: true,
    glob: true,
    shell: true,
    include: ['For workspace search, use the dedicated search tools'],
    exclude: ['use `shell` with commands like `rg`'],
  },
  {
    title: 'explorer with gpt-5 and searchViaShell auto searches through shell and keeps web tools',
    model: 'gpt-5',
    role: 'explorer',
    searchViaShell: 'auto',
    grep: false,
    glob: false,
    shell: true,
    include: ['For workspace search, use `shell` with commands like `rg`'],
    exclude: ['For workspace search, use the dedicated search tools'],
  },
];

it.each(toolCases)('$title', async (c) => {
  let constructedAgent: any = null;

  const providerId = registerTestProvider({
    label: `Mock Tool Test Provider ${c.model} ${c.role} ${c.searchViaShell}`,
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
      'app.searchViaShell': c.searchViaShell,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: c.role, task: 'some task' });

  expect(constructedAgent).toBeTruthy();
  const toolNames: string[] = constructedAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('grep')).toBe(c.grep);
  expect(toolNames.includes('glob')).toBe(c.glob);
  expect(toolNames.includes('shell')).toBe(c.shell);
  for (const text of c.include) {
    expect(constructedAgent.instructions.includes(text)).toBe(true);
  }
  for (const text of c.exclude) {
    expect(constructedAgent.instructions.includes(text)).toBe(false);
  }
});

it('remote execution disables code-context tools and guidance', async () => {
  let remoteAgent: any = null;

  const providerId = registerTestProvider({
    label: 'Mock Tool Test Provider Remote',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          remoteAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
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

it('subagent runtime registers activate_skill tool and appends skills catalog to instructions when skills exist', async () => {
  let subAgent: any = null;

  const providerId = registerTestProvider({
    label: 'Mock Skills Test Provider',
    createStreamedModel: () =>
      ({
        stream: async function* (agent: any) {
          subAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          yield* wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-4o' }],
  });

  const mockSkillsService = {
    getAvailableSkillsForModel: () => [{ name: 'test-skill', description: 'Test skill desc', location: '/path' }],
    getSkillCatalog: () => '<available_skills>Test Skill Catalog</available_skills>',
  };

  const manager = new TestSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-4o',
      'agent.provider': providerId,
    }),
    sessionContextService: createSessionContextService() as any,
    skillsService: mockSkillsService as any,
  });

  await manager.run({ role: 'worker', task: 'perform task with skill' });

  expect(subAgent).toBeTruthy();
  const toolNames: string[] = subAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('activate_skill')).toBe(true);
  expect(subAgent.instructions.includes('<available_skills>Test Skill Catalog</available_skills>')).toBe(true);
});
