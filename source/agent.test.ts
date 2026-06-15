import test from 'ava';
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

test('getAgentDefinition includes grep and find_files when searchViaShell is false', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.true(toolNames.includes('grep'));
  t.true(toolNames.includes('find_files'));
  t.true(toolNames.includes('read_code_outline'));
  t.true(toolNames.includes('code_context_search'));
});

test('getAgentDefinition includes ask_user in standard mode when getAskUserAnswer is provided', (t) => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.true(toolNames.includes('ask_user'));
});

test('getAgentDefinition includes ask_user in lite mode when getAskUserAnswer is provided', (t) => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.liteMode': true }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.true(toolNames.includes('ask_user'));
});

test('getAgentDefinition includes ask_user in orchestrator mode when getAskUserAnswer is provided', (t) => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    runSubagent: async () => 'test',
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.true(toolNames.includes('ask_user'));
});

test('getAgentDefinition omits ask_user when getAskUserAnswer is absent', (t) => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.false(toolNames.includes('ask_user'));
});

test('getAgentDefinition injects delegation guidance in orchestrator mode when runSubagent is provided', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.true(definition.tools.map((tool) => tool.name).includes('run_subagent'));
  t.true(definition.instructions.includes('### Delegating to subagents'));
});

test('getAgentDefinition omits delegation guidance in standard mode even if runSubagent is provided', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.true(definition.tools.map((tool) => tool.name).includes('run_subagent'));
  t.false(definition.instructions.includes('### Delegating to subagents'));
});

test('getAgentDefinition omits delegation guidance when runSubagent is absent', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.false(definition.tools.map((tool) => tool.name).includes('run_subagent'));
  t.false(definition.instructions.includes('### Delegating to subagents'));
});

test('getAgentDefinition omits delegation guidance in lite mode', (t) => {
  const settingsService = createMockSettingsService({
    'app.liteMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.false(definition.tools.map((tool) => tool.name).includes('run_subagent'));
  t.false(definition.instructions.includes('### Delegating to subagents'));
});

test('getAgentDefinition in orchestrator mode exposes run_subagent, shell, read_file, and grep', (t) => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.deepEqual(
    definition.tools.map((tool) => tool.name),
    ['run_subagent', 'shell', 'read_file', 'grep'],
  );
});

test('getAgentDefinition in orchestrator mode requires delegated tool work', (t) => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.true(definition.instructions.includes('Orchestrator mode'));
  t.true(definition.instructions.includes('Delegate workspace inspection'));
  t.false(definition.instructions.includes('Use `read_code_outline`'));
  // Verify non-orchestrator direct-tool guidance is absent from orchestrator instructions
  t.false(definition.instructions.includes('Prefer `read_file` for reading file contents.'));
});

test('getAgentDefinition in orchestrator mode exposes run_subagent, shell, read_file, and grep for non-gpt-5 model', (t) => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.deepEqual(
    definition.tools.map((tool) => tool.name),
    ['run_subagent', 'shell', 'read_file', 'grep'],
  );
});

test('getAgentDefinition throws if orchestratorMode is true and runSubagent is missing', (t) => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  t.throws(
    () =>
      getAgentDefinition({
        settingsService,
        loggingService: mockLogger,
      }),
    { instanceOf: Error, message: /orchestratorMode.*runSubagent|runSubagent.*orchestratorMode/i },
  );
});

test('getAgentDefinition excludes grep and find_files when searchViaShell is true', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.false(toolNames.includes('grep'));
  t.false(toolNames.includes('find_files'));
  t.true(toolNames.includes('read_code_outline'));
  t.true(toolNames.includes('code_context_search'));
});

test('getAgentDefinition preserves read_file and editing tools when searchViaShell is true', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('read_code_outline'));
  t.true(toolNames.includes('code_context_search'));
  t.true(toolNames.includes('search_replace'));
  t.true(toolNames.includes('create_file'));
  t.true(toolNames.includes('shell'));
});

test('getAgentDefinition excludes grep and find_files in lite mode when searchViaShell is true', (t) => {
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
  t.false(toolNames.includes('grep'));
  t.false(toolNames.includes('find_files'));
  t.true(toolNames.includes('read_code_outline'));
  t.true(toolNames.includes('code_context_search'));
  t.true(toolNames.includes('read_file'));
  t.false(toolNames.includes('search_replace'));
});

test('getAgentDefinition for gpt-5 omits grep and find_files regardless of searchViaShell', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  t.false(toolNames.includes('grep'));
  t.false(toolNames.includes('find_files'));
  t.true(toolNames.includes('read_code_outline'));
  t.true(toolNames.includes('code_context_search'));
  t.true(toolNames.includes('apply_patch'));
});

test('getAgentDefinition defaults searchViaShell to true for gpt-5 models when not explicitly configured', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('### Searching via the shell'));
});

test('getAgentDefinition respects explicitly disabled searchViaShell for gpt-5 models', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.false(definition.instructions.includes('### Searching via the shell'));
});

test('getAgentDefinition does not default searchViaShell to true for non-gpt-5 models', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.false(definition.instructions.includes('### Searching via the shell'));
  t.true(definition.instructions.includes('`find_files`'));
  t.true(definition.instructions.includes('`grep`'));
});

test('getAgentDefinition forces searchViaShell on for non-gpt-5 models when explicitly set to on', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('### Searching via the shell'));
  t.false(definition.instructions.includes('`find_files`'));
  t.false(definition.instructions.includes('`grep`'));
});

// test('getAgentDefinition includes GPT version-specific prompt fragments', (t) => {
//   const gpt55 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.5-2026-04-23',
//     }),
//     loggingService: mockLogger,
//   });
//   t.true(gpt55.instructions.includes('## GPT-5.5 Guidance'));
//   t.true(gpt55.instructions.includes('outcome-first behavior'));
//
//   const gpt54 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4',
//     }),
//     loggingService: mockLogger,
//   });
//   t.true(gpt54.instructions.includes('## GPT-5.4 Guidance'));
//   t.false(gpt54.instructions.includes('## GPT-5.4 Small-Model Guidance'));
//
//   const gpt54Mini = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4-mini',
//     }),
//     loggingService: mockLogger,
//   });
//   t.true(gpt54Mini.instructions.includes('## GPT-5.4 Guidance'));
//   t.true(gpt54Mini.instructions.includes('## GPT-5.4 Small-Model Guidance'));
//
//   const gpt53Codex = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.3-codex',
//     }),
//     loggingService: mockLogger,
//   });
//   t.true(gpt53Codex.instructions.includes('## GPT-5.3 Codex Guidance'));
// });

test('getAgentDefinition appends search-via-shell addendum when enabled', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('### Searching via the shell'));
});

test('getAgentDefinition omits dedicated search tool references from prompt when searchViaShell is true', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.false(definition.instructions.includes('`find_files`'));
  t.false(definition.instructions.includes('`grep`'));
});

test('getAgentDefinition dynamically includes dedicated search tool references when searchViaShell is false', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('`find_files`'));
  t.true(definition.instructions.includes('`grep`'));
  t.true(definition.instructions.includes('read_code_outline'));
  t.true(definition.instructions.includes('code_context_search'));
  t.true(definition.instructions.includes('read_file'));
});

test('getAgentDefinition dynamically includes code-context tool references when available', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('read_code_outline'));
  t.true(definition.instructions.includes('code_context_search'));
  t.true(definition.instructions.includes('read_file'));
});

test('getAgentDefinition dynamically includes code-context tool references for gpt-5 models', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definition.instructions.includes('read_code_outline'));
  t.true(definition.instructions.includes('code_context_search'));
});

test('getAgentDefinition uses fallback search prompt for remote execution', (t) => {
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
  t.true(definition.instructions.includes('`grep`'));
  t.true(definition.instructions.includes('`find`'));
  t.false(definition.instructions.includes('`rg`'));
  t.false(definition.instructions.includes('`fd`'));
});

test('getAgentDefinition excludes code-context tools in remote (SSH) execution', (t) => {
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
  t.false(toolNames.includes('read_code_outline'));
  t.false(toolNames.includes('code_context_search'));
  t.false(definition.instructions.includes('read_code_outline'));
});

test('getAgentDefinition does not filter tools based on planMode setting', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });

  const definitionWithPlan = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolsWithPlan = definitionWithPlan.tools.map((tool) => tool.name);
  t.true(toolsWithPlan.includes('create_file'));
  t.true(toolsWithPlan.includes('search_replace'));

  const settingsServiceWithoutPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': false,
  });

  const definitionWithoutPlan = getAgentDefinition({
    settingsService: settingsServiceWithoutPlan,
    loggingService: mockLogger,
  });

  const toolsWithoutPlan = definitionWithoutPlan.tools.map((tool) => tool.name);
  t.true(toolsWithoutPlan.includes('create_file'));
  t.true(toolsWithoutPlan.includes('search_replace'));
});

test('getAgentDefinition includes AGENTS.md and full envInfo for orchestrator mode and plan mode', (t) => {
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
  t.true(definitionOrchestrator.instructions.includes('AGENTS.md contents:'));
  t.true(definitionOrchestrator.instructions.includes('top-level:'));

  // Test Plan Mode
  const settingsPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });
  const definitionPlan = getAgentDefinition({
    settingsService: settingsPlan,
    loggingService: mockLogger,
  });
  t.true(definitionPlan.instructions.includes('AGENTS.md contents:'));
  t.true(definitionPlan.instructions.includes('top-level:'));
});

test('getAgentDefinition includes worktree hygiene fragment in standard, mentor, plan, and orchestrator modes', (t) => {
  const standard = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
    }),
    loggingService: mockLogger,
  });
  t.true(standard.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER));

  const mentor = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.mentorMode': true,
    }),
    loggingService: mockLogger,
  });
  t.true(mentor.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER));

  const plan = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.planMode': true,
    }),
    loggingService: mockLogger,
  });
  t.true(plan.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER));

  const orchestrator = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.orchestratorMode': true,
    }),
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });
  t.true(orchestrator.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER));
});

test('getAgentDefinition omits worktree hygiene fragment in lite mode', (t) => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.liteMode': true,
    }),
    loggingService: mockLogger,
  });

  t.false(definition.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER));
});

test('getAgentDefinition registers activate_skill tool and includes catalog when skills exist', (t) => {
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
  t.true(toolNames.includes('activate_skill'));
  t.true(definition.instructions.includes('<available_skills>Mock Catalog</available_skills>'));
});

test('getAgentDefinition omits activate_skill tool and catalog when skills do not exist', (t) => {
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
  t.false(toolNames.includes('activate_skill'));
  t.false(definition.instructions.includes('<available_skills>'));
});
