import test from 'ava';
import { getAgentDefinition } from './agent.js';
import { createMockSettingsService } from './services/settings-service.mock.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
} as any;

test('getAgentDefinition includes grep and find_files when searchViaShell is false', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': false,
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

test('getAgentDefinition injects delegation guidance when runSubagent is provided', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  t.true(definition.tools.map((tool) => tool.name).includes('run_subagent'));
  t.true(definition.instructions.includes('### Delegating to subagents'));
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

test('getAgentDefinition in orchestrator mode exposes run_subagent, read_file, and grep', (t) => {
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
    ['run_subagent', 'read_file', 'grep'],
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
  t.true(definition.instructions.includes('must delegate'));
  t.false(definition.instructions.includes('Use `read_code_outline`'));
  // Verify non-orchestrator direct-tool guidance is absent from orchestrator instructions
  t.false(definition.instructions.includes('Prefer `read_file` for reading file contents.'));
});

test('getAgentDefinition in orchestrator mode exposes run_subagent, read_file, and grep for non-gpt-5 model', (t) => {
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
    ['run_subagent', 'read_file', 'grep'],
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': false,
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

test('getAgentDefinition appends search-via-shell addendum when enabled', (t) => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': true,
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': false,
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': false,
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
    'app.searchViaShell': true,
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
    'app.searchViaShell': false,
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

test('getAgentDefinition unconditionally includes plan mode instructions and does not filter tools based on planMode setting', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });

  const definitionWithPlan = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  t.true(definitionWithPlan.instructions.includes('Plan Mode'));
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

  t.true(definitionWithoutPlan.instructions.includes('Plan Mode'));
  const toolsWithoutPlan = definitionWithoutPlan.tools.map((tool) => tool.name);
  t.true(toolsWithoutPlan.includes('create_file'));
  t.true(toolsWithoutPlan.includes('search_replace'));
});
