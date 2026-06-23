import { it, expect } from 'vitest';
import { getAgentDefinition } from './agent.js';
import { createMockSettingsService } from './services/settings/settings-service.mock.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
} as any;

const WORKTREE_HYGIENE_FRAGMENT_MARKER = 'Before making any code changes, inspect the repo worktree.';

it('getAgentDefinition includes grep and glob when searchViaShell is false', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('glob')).toBe(true);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
});

it('getAgentDefinition includes ask_user in standard mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition includes ask_user in lite mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.liteMode': true }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition includes ask_user in orchestrator mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    runSubagent: async () => 'test',
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition omits ask_user when getAskUserAnswer is absent', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(false);
});

it('getAgentDefinition injects delegation guidance in orchestrator mode when runSubagent is provided', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(true);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(true);
});

it('getAgentDefinition omits delegation guidance in standard mode even if runSubagent is provided', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(true);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition omits delegation guidance when runSubagent is absent', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition omits delegation guidance in lite mode', () => {
  const settingsService = createMockSettingsService({
    'app.liteMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition in orchestrator mode exposes run_subagent, shell, read_file, and grep', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual(['run_subagent', 'shell', 'read_file', 'grep']);
});

it('getAgentDefinition in orchestrator mode requires delegated tool work', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.instructions.includes('Orchestrator mode')).toBe(true);
  expect(definition.instructions.includes('Delegate workspace inspection')).toBe(true);
  expect(definition.instructions.includes('Use `read_code_outline`')).toBe(false);
  // Verify non-orchestrator direct-tool guidance is absent from orchestrator instructions
  expect(definition.instructions.includes('Prefer `read_file` for reading file contents.')).toBe(false);
});

it('getAgentDefinition in orchestrator mode exposes run_subagent, shell, read_file, and grep for non-gpt-5 model', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual(['run_subagent', 'shell', 'read_file', 'grep']);
});

it('getAgentDefinition throws if orchestratorMode is true and runSubagent is missing', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  expect(() =>
    getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    }),
  ).toThrow(/orchestratorMode.*runSubagent|runSubagent.*orchestratorMode/i);
});

it('getAgentDefinition excludes grep and glob when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
});

it('getAgentDefinition preserves read_file and editing tools when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('search_replace')).toBe(true);
  expect(toolNames.includes('create_file')).toBe(true);
  expect(toolNames.includes('shell')).toBe(true);
});

it('getAgentDefinition excludes grep and glob in lite mode when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'app.liteMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('search_replace')).toBe(false);
});

it('getAgentDefinition for gpt-5 omits grep and glob regardless of searchViaShell', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('apply_patch')).toBe(true);
});

it('getAgentDefinition defaults searchViaShell to true for gpt-5 models when not explicitly configured', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
});

it('getAgentDefinition respects explicitly disabled searchViaShell for gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(false);
});

it('getAgentDefinition does not default searchViaShell to true for non-gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(false);
  expect(definition.instructions.includes('`glob`')).toBe(true);
  expect(definition.instructions.includes('`grep`')).toBe(true);
});

it('getAgentDefinition forces searchViaShell on for non-gpt-5 models when explicitly set to on', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
  expect(definition.instructions.includes('`glob`')).toBe(false);
  expect(definition.instructions.includes('`grep`')).toBe(false);
});

// it('getAgentDefinition includes GPT version-specific prompt fragments', () => {
//   const gpt55 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.5-2026-04-23',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt55.instructions.includes('## GPT-5.5 Guidance')).toBe(true);
//   expect(gpt55.instructions.includes('outcome-first behavior')).toBe(true);
//
//   const gpt54 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt54.instructions.includes('## GPT-5.4 Guidance')).toBe(true);
//   expect(gpt54.instructions.includes('## GPT-5.4 Small-Model Guidance')).toBe(false);
//
//   const gpt54Mini = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4-mini',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt54Mini.instructions.includes('## GPT-5.4 Guidance')).toBe(true);
//   expect(gpt54Mini.instructions.includes('## GPT-5.4 Small-Model Guidance')).toBe(true);
//
//   const gpt53Codex = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.3-codex',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt53Codex.instructions.includes('## GPT-5.3 Codex Guidance')).toBe(true);
// });

it('getAgentDefinition appends search-via-shell addendum when enabled', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
});

it('getAgentDefinition omits dedicated search tool references from prompt when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('`glob`')).toBe(false);
  expect(definition.instructions.includes('`grep`')).toBe(false);
});

it('getAgentDefinition dynamically includes dedicated search tool references when searchViaShell is false', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('`glob`')).toBe(true);
  expect(definition.instructions.includes('`grep`')).toBe(true);
  expect(definition.instructions.includes('read_code_outline')).toBe(true);
  expect(definition.instructions.includes('code_context_search')).toBe(true);
  expect(definition.instructions.includes('read_file')).toBe(true);
});

it('getAgentDefinition dynamically includes code-context tool references when available', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('read_code_outline')).toBe(true);
  expect(definition.instructions.includes('code_context_search')).toBe(true);
  expect(definition.instructions.includes('read_file')).toBe(true);
});

it('getAgentDefinition dynamically includes code-context tool references for gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('read_code_outline')).toBe(true);
  expect(definition.instructions.includes('code_context_search')).toBe(true);
});

it('getAgentDefinition uses fallback search prompt for remote execution', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const mockExecutionContext = {
    isRemote: () => true,
    getCwd: () => '/remote',
    getSSHService: () => ({}),
  } as any;

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    executionContext: mockExecutionContext,
  });

  // Remote should always fallback to grep/find instructions
  expect(definition.instructions.includes('`grep`')).toBe(true);
  expect(definition.instructions.includes('`find`')).toBe(true);
  expect(definition.instructions.includes('`rg`')).toBe(false);
  expect(definition.instructions.includes('`fd`')).toBe(false);
});

it('getAgentDefinition excludes code-context tools in remote (SSH) execution', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const mockExecutionContext = {
    isRemote: () => true,
    getCwd: () => '/remote',
    getSSHService: () => ({}),
  } as any;

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    executionContext: mockExecutionContext,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('read_code_outline')).toBe(false);
  expect(toolNames.includes('code_context_search')).toBe(false);
  expect(definition.instructions.includes('read_code_outline')).toBe(false);
});

it('getAgentDefinition does not filter tools based on planMode setting', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });

  const definitionWithPlan = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolsWithPlan = definitionWithPlan.tools.map((tool) => tool.name);
  expect(toolsWithPlan.includes('create_file')).toBe(true);
  expect(toolsWithPlan.includes('search_replace')).toBe(true);

  const settingsServiceWithoutPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': false,
  });

  const definitionWithoutPlan = getAgentDefinition({
    settingsService: settingsServiceWithoutPlan,
    loggingService: mockLogger,
  });

  const toolsWithoutPlan = definitionWithoutPlan.tools.map((tool) => tool.name);
  expect(toolsWithoutPlan.includes('create_file')).toBe(true);
  expect(toolsWithoutPlan.includes('search_replace')).toBe(true);
});

it('getAgentDefinition includes AGENTS.md and full envInfo for orchestrator mode and plan mode', () => {
  // Test Orchestrator Mode
  const settingsOrchestrator = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });
  const definitionOrchestrator = getAgentDefinition({
    settingsService: settingsOrchestrator,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });
  expect(definitionOrchestrator.instructions.includes('AGENTS.md contents:')).toBe(true);
  expect(definitionOrchestrator.instructions.includes('Project structure:')).toBe(true);

  // Test Plan Mode
  const settingsPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });
  const definitionPlan = getAgentDefinition({
    settingsService: settingsPlan,
    loggingService: mockLogger,
  });
  expect(definitionPlan.instructions.includes('AGENTS.md contents:')).toBe(true);
  expect(definitionPlan.instructions.includes('Project structure:')).toBe(true);
});

it('getAgentDefinition includes worktree hygiene fragment in standard, mentor, plan, and orchestrator modes', () => {
  const standard = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
    }),
    loggingService: mockLogger,
  });
  expect(standard.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const mentor = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.mentorMode': true,
    }),
    loggingService: mockLogger,
  });
  expect(mentor.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const plan = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.planMode': true,
    }),
    loggingService: mockLogger,
  });
  expect(plan.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const orchestrator = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.orchestratorMode': true,
    }),
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });
  expect(orchestrator.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);
});

it('getAgentDefinition omits worktree hygiene fragment in lite mode', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.liteMode': true,
    }),
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(false);
});

it('getAgentDefinition registers activate_skill tool and includes catalog when skills exist', () => {
  const mockSkillsService = {
    getAvailableSkillsForModel: () => [
      {
        name: 'test-skill',
        description: 'Test skill description',
        location: '/path/to/SKILL.md',
        isProjectLevel: true,
        body: 'Body',
        rawContent: 'Raw',
      },
    ],
    getSkillCatalog: () => '<available_skills>Mock Catalog</available_skills>',
  } as any;

  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    skillsService: mockSkillsService,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('activate_skill')).toBe(true);
  expect(definition.instructions.includes('<available_skills>Mock Catalog</available_skills>')).toBe(true);
});

it('getAgentDefinition omits activate_skill tool and catalog when skills do not exist', () => {
  const mockSkillsService = {
    getAvailableSkillsForModel: () => [],
    getSkillCatalog: () => '',
  } as any;

  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    skillsService: mockSkillsService,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('activate_skill')).toBe(false);
  expect(definition.instructions.includes('<available_skills>')).toBe(false);
});
