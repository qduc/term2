import { it, expect } from 'vitest';
import {
  buildSettingsList,
  filterSettingsByQuery,
  clampIndex,
  getSettingCategory,
  filterSettingsByCategory,
  SETTINGS_CATEGORIES,
} from './use-settings-completion.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { SETTING_DESCRIPTIONS } from './settings-completion-config.js';

// Mock setting keys for testing (matching actual SETTING_KEYS structure)
const MOCK_SETTING_KEYS = {
  AGENT_MODEL: 'agent.model',
  AGENT_REASONING_EFFORT: 'agent.reasoningEffort',
  AGENT_PROVIDER: 'agent.provider',
  AGENT_MAX_TURNS: 'agent.maxTurns',
  AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
  AGENT_MAX_PARALLEL_TOOL_CALLS: 'agent.maxParallelToolCalls',
  AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
  AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl',
  AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer',
  AGENT_OPENROUTER_TITLE: 'agent.openrouter.title',
  AGENT_MENTOR_MODEL: 'agent.mentorModel',
  AGENT_MENTOR_PROVIDER: 'agent.mentorProvider',
  AGENT_MENTOR_REASONING_EFFORT: 'agent.mentorReasoningEffort',
  SHELL_TIMEOUT: 'shell.timeout',
  SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
  SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
  UI_HISTORY_SIZE: 'ui.historySize',
  LOGGING_LOG_LEVEL: 'logging.logLevel',
  LOGGING_DISABLE: 'logging.disableLogging',
  LOGGING_DEBUG: 'logging.debugLogging',
  LOGGING_SUPPRESS_CONSOLE: 'logging.suppressConsoleOutput',
  ENV_NODE_ENV: 'environment.nodeEnv',
  APP_SHELL_PATH: 'app.shellPath',
  TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
  DEBUG_BASH_TOOL: 'debug.debugBashTool',
  WEB_SEARCH_PROVIDER: 'webSearch.provider',
} as const;

const MOCK_DESCRIPTIONS: Record<string, string> = {
  'agent.model': 'The AI model to use (e.g. gpt-4, claude-3-opus)',
  'agent.reasoningEffort': 'Reasoning effort level (default, low, medium, high)',
  'agent.provider': 'AI provider (openai, openrouter)',
  'agent.maxTurns': 'Maximum conversation turns',
  'agent.retryAttempts': 'Number of retry attempts for failed requests',
  'agent.maxParallelToolCalls': 'Maximum number of tool calls allowed to run at the same time',
  'agent.openrouter.apiKey': 'OpenRouter API key',
  'agent.openrouter.baseUrl': 'OpenRouter base URL',
  'agent.openrouter.referrer': 'OpenRouter referrer',
  'agent.openrouter.title': 'OpenRouter title',
  'agent.mentorModel': 'Mentor model to use',
  'agent.mentorProvider': 'Mentor provider to use',
  'agent.mentorReasoningEffort': 'Mentor reasoning effort',
  'shell.timeout': 'Shell command timeout in milliseconds',
  'shell.maxOutputLines': 'Maximum lines of shell output to capture',
  'shell.maxOutputChars': 'Maximum characters of shell output to capture',
  'ui.historySize': 'Number of history items to keep',
  'logging.logLevel': 'Logging level (debug, info, warn, error)',
  'logging.disableLogging': 'Disable all logging',
  'logging.debugLogging': 'Enable debug logging',
  'logging.suppressConsoleOutput': 'Suppress console output to avoid interfering with Ink UI',
  'environment.nodeEnv': 'Node environment (development, production)',
  'app.shellPath': 'Path to shell executable',
  'tools.logFileOperations': 'Log file operations to disk',
  'debug.debugBashTool': 'Enable bash tool debugging',
  'webSearch.provider': 'Web search provider (tavily, exa)',
};

// buildSettingsList tests
it('buildSettingsList - exposes the agent workflow feature flag', () => {
  const result = buildSettingsList(SETTING_KEYS, SETTING_DESCRIPTIONS);

  expect(result).toContainEqual(
    expect.objectContaining({
      key: 'enable_agent_workflow',
      description: expect.any(String),
    }),
  );
  expect(getSettingCategory('enable_agent_workflow').id).toBe('tools');
});

it('buildSettingsList - exposes workflow model tiers in the models category', () => {
  const result = buildSettingsList(SETTING_KEYS, SETTING_DESCRIPTIONS);

  expect(result).toContainEqual(
    expect.objectContaining({ key: 'agent.efficientModel', description: expect.any(String) }),
  );
  expect(result).toContainEqual(
    expect.objectContaining({ key: 'agent.capableModel', description: expect.any(String) }),
  );
  expect(getSettingCategory('agent.efficientModel').id).toBe('models');
  expect(getSettingCategory('agent.capableModel').id).toBe('models');
});

it('buildSettingsList - creates list from keys and descriptions', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const excludedKeys = new Set([
    'agent.provider',
    'agent.mentorProvider',
    'agent.openrouter.apiKey',
    'agent.openrouter.baseUrl',
    'agent.openrouter.referrer',
    'agent.openrouter.title',
    'logging.debugLogging',
    'logging.suppressConsoleOutput',
    'environment.nodeEnv',
    'app.shellPath',
    'tools.logFileOperations',
    'debug.debugBashTool',
  ]);
  const expectedCount = Object.values(MOCK_SETTING_KEYS).filter((key) => !excludedKeys.has(key)).length;
  expect(result.length).toBe(expectedCount);
  expect(result.every(() => true)).toBe(true);
  expect(result.every((item) => item.description !== undefined)).toBe(true);
});

it('buildSettingsList - excludes sensitive settings by default', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = new Set(result.map((item) => item.key));

  // Should not include sensitive settings
  expect(keys.has('agent.openrouter.apiKey')).toBe(false);
  expect(keys.has('agent.openrouter.baseUrl')).toBe(false);
  expect(keys.has('agent.openrouter.referrer')).toBe(false);
  expect(keys.has('agent.openrouter.title')).toBe(false);
  expect(keys.has('app.shellPath')).toBe(false);

  // Should include non-sensitive settings
  expect(keys.has('agent.model')).toBe(true);
  expect(keys.has('shell.timeout')).toBe(true);
});

it('buildSettingsList - can include sensitive settings when requested', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, false);
  const keys = new Set(result.map((item) => item.key));

  const hiddenKeys = new Set([
    'agent.provider',
    'agent.mentorProvider',
    'logging.debugLogging',
    'logging.suppressConsoleOutput',
    'environment.nodeEnv',
    'app.shellPath',
    'tools.logFileOperations',
    'debug.debugBashTool',
  ]);
  const expectedCount = Object.values(MOCK_SETTING_KEYS).filter((key) => !hiddenKeys.has(key)).length;

  // Should include all settings except UI-hidden ones when excludeSensitive is false
  expect(result.length).toBe(expectedCount);
  expect(keys.has('agent.openrouter.apiKey')).toBe(true);
  expect(keys.has('app.shellPath')).toBe(false);
  // Hidden settings should still be excluded
  expect(keys.has('agent.provider')).toBe(false);
});

it('buildSettingsList - includes all non-sensitive setting keys', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = result.map((item) => item.key);

  // Check specific non-sensitive keys that should be included
  const nonSensitiveKeys = [
    'agent.model',
    'agent.reasoningEffort',
    'agent.maxTurns',
    'agent.maxParallelToolCalls',
    'shell.timeout',
    'logging.logLevel',
  ];

  for (const settingKey of nonSensitiveKeys) {
    expect(keys.includes(settingKey)).toBe(true);
  }
});

it('buildSettingsList - maps descriptions correctly', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  for (const item of result) {
    expect(item.description).toBe(MOCK_DESCRIPTIONS[item.key]);
  }
});

it('buildSettingsList - includes current values when provided', () => {
  const mockGetCurrentValue = (key: string): string | number | boolean => {
    const values: Record<string, string | number | boolean> = {
      'agent.model': 'gpt-4o',
      'shell.timeout': 120000,
      'logging.logLevel': 'info',
    };
    return values[key] ?? 'default';
  };

  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, true, mockGetCurrentValue);

  const agentModel = result.find((item) => item.key === 'agent.model');
  const shellTimeout = result.find((item) => item.key === 'shell.timeout');
  const logLevel = result.find((item) => item.key === 'logging.logLevel');

  expect(agentModel?.currentValue).toBe('gpt-4o');
  expect(shellTimeout?.currentValue).toBe(120000);
  expect(logLevel?.currentValue).toBe('info');
});

it('buildSettingsList - handles missing current values', () => {
  const mockGetCurrentValue = (key: string): string | number | boolean | undefined => {
    if (key === 'agent.model') {
      return 'gpt-4o';
    }
    return undefined;
  };

  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, true, mockGetCurrentValue);

  const agentModel = result.find((item) => item.key === 'agent.model');
  const shellTimeout = result.find((item) => item.key === 'shell.timeout');

  expect(agentModel?.currentValue).toBe('gpt-4o');
  expect(shellTimeout?.currentValue).toBe(undefined);
});

it('buildSettingsList - handles missing descriptions with empty string', () => {
  const incompleteDescriptions = {
    'agent.model': 'Model description',
  };

  const result = buildSettingsList(MOCK_SETTING_KEYS, incompleteDescriptions);

  const agentModel = result.find((item) => item.key === 'agent.model');
  const shellTimeout = result.find((item) => item.key === 'shell.timeout');

  expect(agentModel?.description).toBe('Model description');
  expect(shellTimeout?.description).toBe('');
});

it('buildSettingsList - handles empty descriptions object', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, {});

  const excludedKeys = new Set([
    'agent.provider',
    'agent.mentorProvider',
    'agent.openrouter.apiKey',
    'agent.openrouter.baseUrl',
    'agent.openrouter.referrer',
    'agent.openrouter.title',
    'logging.debugLogging',
    'logging.suppressConsoleOutput',
    'environment.nodeEnv',
    'app.shellPath',
    'tools.logFileOperations',
    'debug.debugBashTool',
  ]);
  const expectedCount = Object.values(MOCK_SETTING_KEYS).filter((key) => !excludedKeys.has(key)).length;
  expect(result.length).toBe(expectedCount);
  expect(result.every((item) => item.description === '')).toBe(true);
});

it('buildSettingsList - no duplicate keys', () => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = result.map((item) => item.key);
  const uniqueKeys = new Set(keys);

  expect(keys.length, 'Duplicate keys found').toBe(uniqueKeys.size);
});

it('getSettingCategory - groups settings by task-oriented menu tabs', () => {
  const categoryIds = new Set(SETTINGS_CATEGORIES.map((c) => c.id));

  // Check that the returned category is always a valid category in SETTINGS_CATEGORIES
  expect(categoryIds.has(getSettingCategory('agent.model').id)).toBe(true);
  expect(categoryIds.has(getSettingCategory('shell.timeout').id)).toBe(true);
  expect(categoryIds.has(getSettingCategory('app.planMode').id)).toBe(true);

  // Verify specific expected mappings for key settings
  expect(getSettingCategory('agent.model').id).toBe('models');
  expect(getSettingCategory('agent.mentorModel').id).toBe('models');
  expect(getSettingCategory('shell.autoApproveMode').id).toBe('safety');
  expect(getSettingCategory('shell.timeout').id).toBe('tools');
  expect(getSettingCategory('sandbox.enabled').id).toBe('safety');
  expect(getSettingCategory('sandbox.readPolicy').id).toBe('safety');
  expect(getSettingCategory('app.searchViaShell').id).toBe('tools');
  expect(getSettingCategory('agent.maxParallelToolCalls').id).toBe('misc');
  expect(getSettingCategory('agent.subagentWorkerModel').id).toBe('models');
  expect(getSettingCategory('ui.pasteThreshold').id).toBe('ui');
});

it('filterSettingsByCategory - limits visible settings to the active task tab', () => {
  const settings = [{ key: 'agent.model' }, { key: 'shell.timeout' }, { key: 'webSearch.provider' }];

  const result = filterSettingsByCategory(settings, 'tools');

  expect(result.map((item) => item.key)).toEqual(['shell.timeout', 'webSearch.provider']);
});

// filterSettingsByQuery tests
it('filterSettingsByQuery - empty query returns limited settings', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, '', 3);
  expect(result.length).toBe(3);
});

it('filterSettingsByQuery - whitespace-only query returns limited settings', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, '   ', 3);
  expect(result.length).toBe(3);
});

it('filterSettingsByQuery - exact key match returns result', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, 'agent.model', 10);
  expect(result.length > 0).toBe(true);
  expect(result.some((item) => item.key === 'agent.model')).toBe(true);
});

it('filterSettingsByQuery - partial key match returns results', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const cases = [
    { query: 'agent', expectedKeySubstring: 'agent' },
    { query: 'shell', expectedKeySubstring: 'shell' },
    { query: 'model', expectedKeySubstring: 'model' },
  ];

  for (const { query, expectedKeySubstring } of cases) {
    const result = filterSettingsByQuery(settings, query, 10);
    expect(result.length > 0).toBe(true);
    expect(result.some((item) => item.key.includes(expectedKeySubstring))).toBe(true);
  }
});

it('filterSettingsByQuery - search by description returns results', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const cases = [
    { query: 'timeout', expectedKey: 'shell.timeout' },
    { query: 'model', expectedKey: 'agent.model' },
    { query: 'logging', expectedKey: 'logging.logLevel' },
  ];

  for (const { query, expectedKey } of cases) {
    const result = filterSettingsByQuery(settings, query, 10);
    expect(result.length > 0).toBe(true);
    expect(result.some((item) => item.key === expectedKey)).toBe(true);
  }
});

it('filterSettingsByQuery - respects maxResults parameter for search queries', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Use a broad query that matches multiple settings
  const result1 = filterSettingsByQuery(settings, 'agent', 2);
  expect(result1.length <= 2).toBe(true);

  const result2 = filterSettingsByQuery(settings, 'agent', 4);
  expect(result2.length <= 4).toBe(true);

  const result3 = filterSettingsByQuery(settings, 'agent', 100);
  expect(result3.length <= settings.length).toBe(true);
});

it('filterSettingsByQuery - case insensitive search', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const lowerCase = filterSettingsByQuery(settings, 'agent', 10);
  const upperCase = filterSettingsByQuery(settings, 'AGENT', 10);
  const mixedCase = filterSettingsByQuery(settings, 'AgEnT', 10);

  expect(lowerCase.length > 0).toBe(true);
  expect(upperCase.length > 0).toBe(true);
  expect(mixedCase.length > 0).toBe(true);
  expect(lowerCase.length).toBe(upperCase.length);
  expect(lowerCase.length).toBe(mixedCase.length);
});

it('filterSettingsByQuery - handles query with no matches', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, 'xyzzzznonexistent', 10);
  expect(result.length).toBe(0);
});

it('filterSettingsByQuery - trims query before searching', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const trimmed = filterSettingsByQuery(settings, 'agent', 10);
  const withSpaces = filterSettingsByQuery(settings, '  agent  ', 10);

  expect(trimmed.length > 0).toBe(true);
  expect(trimmed.length).toBe(withSpaces.length);
});

it('filterSettingsByQuery - handles empty settings array', () => {
  const result = filterSettingsByQuery([], 'agent', 10);
  expect(result.length).toBe(0);
});

it('filterSettingsByQuery - description matching requires substring match, not loose subsequence', () => {
  const settings = [
    {
      key: 'app.searchViaShell',
      description: 'Use shell commands (ripgrep/find) for codebase search instead of built-in tools (true|false)',
    },
  ];

  // "model" is a subsequence in the description but not a substring
  const result = filterSettingsByQuery(settings, 'model', 10);
  expect(result.length).toBe(0);

  // "shell" is a substring in the description
  const result2 = filterSettingsByQuery(settings, 'shell', 10);
  expect(result2.length).toBe(1);
  expect(result2[0].key).toBe('app.searchViaShell');
});

// clampIndex tests
it('clampIndex - returns 0 when array is empty', () => {
  expect(clampIndex(0, 0)).toBe(0);
  expect(clampIndex(5, 0)).toBe(0);
  expect(clampIndex(100, 0)).toBe(0);
});

it('clampIndex - returns same index when within bounds', () => {
  const cases = [
    { index: 0, length: 5, expected: 0 },
    { index: 2, length: 5, expected: 2 },
    { index: 4, length: 5, expected: 4 },
  ];

  for (const { index, length, expected } of cases) {
    expect(clampIndex(index, length), `Index ${index} in length ${length}`).toBe(expected);
  }
});

it('clampIndex - clamps to max index when out of bounds', () => {
  const cases = [
    { index: 5, length: 5, expected: 4 },
    { index: 10, length: 5, expected: 4 },
    { index: 100, length: 3, expected: 2 },
  ];

  for (const { index, length, expected } of cases) {
    expect(clampIndex(index, length), `Index ${index} clamped in length ${length}`).toBe(expected);
  }
});

it('clampIndex - handles length of 1', () => {
  expect(clampIndex(0, 1)).toBe(0);
  expect(clampIndex(1, 1)).toBe(0);
  expect(clampIndex(10, 1)).toBe(0);
});

it('clampIndex - clamps negative index to first item', () => {
  expect(clampIndex(-1, 5)).toBe(0);
});

// Integration tests
it('Integration - buildSettingsList and filterSettingsByQuery work together', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Search for "model" should find agent.model
  const result = filterSettingsByQuery(settings, 'model', 10);
  expect(result.some((item) => item.key === 'agent.model')).toBe(true);
  expect(result.some((item) => item.description?.includes('model'))).toBe(true);
});

it('Integration - clampIndex with filtered results', () => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Get filtered results
  const filtered = filterSettingsByQuery(settings, 'agent', 3);

  // Clamp selection index to filtered results
  expect(clampIndex(0, filtered.length)).toBe(0);
  expect(clampIndex(10, filtered.length)).toBe(filtered.length - 1);
});
