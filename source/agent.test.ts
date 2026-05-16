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

  t.false(definition.instructions.includes('Prefer `find_files`'));
  t.false(definition.instructions.includes('Prefer `grep`'));
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

  t.true(definition.instructions.includes('Prefer `find_files`'));
  t.true(definition.instructions.includes('Prefer `grep`'));
  t.true(definition.instructions.includes('read_code_outline'));
  t.true(definition.instructions.includes('code_context_search'));
  t.true(definition.instructions.includes('Use `read_file` before editing'));
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
  t.true(definition.instructions.includes('Use `read_file` before editing'));
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
  t.true(definition.instructions.includes('use `grep`'));
  t.true(definition.instructions.includes('use `find`'));
  t.false(definition.instructions.includes('use `rg` (ripgrep)'));
  t.false(definition.instructions.includes('use `fd`'));
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
