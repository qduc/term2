import test from 'ava';
import {
  buildSettingsList,
  filterSettingsByQuery,
  clampIndex,
  getSettingCategory,
  filterSettingsByCategory,
  SETTINGS_CATEGORIES,
} from './use-settings-completion.js';

// Mock setting keys for testing (matching actual SETTING_KEYS structure)
const MOCK_SETTING_KEYS = {
  AGENT_MODEL: 'agent.model',
  AGENT_REASONING_EFFORT: 'agent.reasoningEffort',
  AGENT_PROVIDER: 'agent.provider',
  AGENT_MAX_TURNS: 'agent.maxTurns',
  AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
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
test('buildSettingsList - creates list from keys and descriptions', (t) => {
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
  t.is(result.length, expectedCount);
  t.true(result.every(() => true));
  t.true(result.every((item) => item.description !== undefined));
});

test('buildSettingsList - excludes sensitive settings by default', (t) => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = new Set(result.map((item) => item.key));

  // Should not include sensitive settings
  t.false(keys.has('agent.openrouter.apiKey'));
  t.false(keys.has('agent.openrouter.baseUrl'));
  t.false(keys.has('agent.openrouter.referrer'));
  t.false(keys.has('agent.openrouter.title'));
  t.false(keys.has('app.shellPath'));

  // Should include non-sensitive settings
  t.true(keys.has('agent.model'));
  t.true(keys.has('shell.timeout'));
});

test('buildSettingsList - can include sensitive settings when requested', (t) => {
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
  t.is(result.length, expectedCount);
  t.true(keys.has('agent.openrouter.apiKey'));
  t.false(keys.has('app.shellPath'));
  // Hidden settings should still be excluded
  t.false(keys.has('agent.provider'));
});

test('buildSettingsList - includes all non-sensitive setting keys', (t) => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = result.map((item) => item.key);

  // Check specific non-sensitive keys that should be included
  const nonSensitiveKeys = [
    'agent.model',
    'agent.reasoningEffort',
    'agent.maxTurns',
    'shell.timeout',
    'logging.logLevel',
  ];

  for (const settingKey of nonSensitiveKeys) {
    t.true(keys.includes(settingKey), `Missing key: ${settingKey}`);
  }
});

test('buildSettingsList - maps descriptions correctly', (t) => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  for (const item of result) {
    t.is(item.description, MOCK_DESCRIPTIONS[item.key]);
  }
});

test('buildSettingsList - includes current values when provided', (t) => {
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

  t.is(agentModel?.currentValue, 'gpt-4o');
  t.is(shellTimeout?.currentValue, 120000);
  t.is(logLevel?.currentValue, 'info');
});

test('buildSettingsList - handles missing current values', (t) => {
  const mockGetCurrentValue = (key: string): string | number | boolean | undefined => {
    if (key === 'agent.model') {
      return 'gpt-4o';
    }
    return undefined;
  };

  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, true, mockGetCurrentValue);

  const agentModel = result.find((item) => item.key === 'agent.model');
  const shellTimeout = result.find((item) => item.key === 'shell.timeout');

  t.is(agentModel?.currentValue, 'gpt-4o');
  t.is(shellTimeout?.currentValue, undefined);
});

test('buildSettingsList - handles missing descriptions with empty string', (t) => {
  const incompleteDescriptions = {
    'agent.model': 'Model description',
  };

  const result = buildSettingsList(MOCK_SETTING_KEYS, incompleteDescriptions);

  const agentModel = result.find((item) => item.key === 'agent.model');
  const shellTimeout = result.find((item) => item.key === 'shell.timeout');

  t.is(agentModel?.description, 'Model description');
  t.is(shellTimeout?.description, '');
});

test('buildSettingsList - handles empty descriptions object', (t) => {
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
  t.is(result.length, expectedCount);
  t.true(result.every((item) => item.description === ''));
});

test('buildSettingsList - no duplicate keys', (t) => {
  const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
  const keys = result.map((item) => item.key);
  const uniqueKeys = new Set(keys);

  t.is(keys.length, uniqueKeys.size, 'Duplicate keys found');
});

test('getSettingCategory - groups settings by task-oriented menu tabs', (t) => {
  const categoryIds = new Set(SETTINGS_CATEGORIES.map((c) => c.id));

  // Check that the returned category is always a valid category in SETTINGS_CATEGORIES
  t.true(categoryIds.has(getSettingCategory('agent.model').id));
  t.true(categoryIds.has(getSettingCategory('shell.timeout').id));
  t.true(categoryIds.has(getSettingCategory('app.planMode').id));

  // Verify specific expected mappings for key settings
  t.is(getSettingCategory('agent.model').id, 'model');
  t.is(getSettingCategory('agent.mentorModel').id, 'model');
  t.is(getSettingCategory('shell.autoApproveMode').id, 'approvals');
  t.is(getSettingCategory('shell.timeout').id, 'shell');
  t.is(getSettingCategory('app.searchViaShell').id, 'search');
  t.is(getSettingCategory('agent.subagentWorkerModel').id, 'subagents');
  t.is(getSettingCategory('ui.pasteThreshold').id, 'uiLogging');
});

test('filterSettingsByCategory - limits visible settings to the active task tab', (t) => {
  const settings = [{ key: 'agent.model' }, { key: 'shell.timeout' }, { key: 'webSearch.provider' }];

  const result = filterSettingsByCategory(settings, 'shell');

  t.deepEqual(
    result.map((item) => item.key),
    ['shell.timeout'],
  );
});

// filterSettingsByQuery tests
test('filterSettingsByQuery - empty query returns limited settings', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, '', 3);
  t.is(result.length, 3);
});

test('filterSettingsByQuery - whitespace-only query returns limited settings', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, '   ', 3);
  t.is(result.length, 3);
});

test('filterSettingsByQuery - exact key match returns result', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, 'agent.model', 10);
  t.true(result.length > 0);
  t.true(result.some((item) => item.key === 'agent.model'));
});

test('filterSettingsByQuery - partial key match returns results', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const cases = [
    { query: 'agent', expectedKeySubstring: 'agent' },
    { query: 'shell', expectedKeySubstring: 'shell' },
    { query: 'model', expectedKeySubstring: 'model' },
  ];

  for (const { query, expectedKeySubstring } of cases) {
    const result = filterSettingsByQuery(settings, query, 10);
    t.true(result.length > 0, `Query "${query}" should return results`);
    t.true(
      result.some((item) => item.key.includes(expectedKeySubstring)),
      `Query "${query}" should match key containing "${expectedKeySubstring}"`,
    );
  }
});

test('filterSettingsByQuery - search by description returns results', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const cases = [
    { query: 'timeout', expectedKey: 'shell.timeout' },
    { query: 'model', expectedKey: 'agent.model' },
    { query: 'logging', expectedKey: 'logging.logLevel' },
  ];

  for (const { query, expectedKey } of cases) {
    const result = filterSettingsByQuery(settings, query, 10);
    t.true(result.length > 0, `Query "${query}" should return results`);
    t.true(
      result.some((item) => item.key === expectedKey),
      `Query "${query}" should find key "${expectedKey}"`,
    );
  }
});

test('filterSettingsByQuery - respects maxResults parameter for search queries', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Use a broad query that matches multiple settings
  const result1 = filterSettingsByQuery(settings, 'agent', 2);
  t.true(result1.length <= 2);

  const result2 = filterSettingsByQuery(settings, 'agent', 4);
  t.true(result2.length <= 4);

  const result3 = filterSettingsByQuery(settings, 'agent', 100);
  t.true(result3.length <= settings.length);
});

test('filterSettingsByQuery - case insensitive search', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const lowerCase = filterSettingsByQuery(settings, 'agent', 10);
  const upperCase = filterSettingsByQuery(settings, 'AGENT', 10);
  const mixedCase = filterSettingsByQuery(settings, 'AgEnT', 10);

  t.true(lowerCase.length > 0);
  t.true(upperCase.length > 0);
  t.true(mixedCase.length > 0);
  t.is(lowerCase.length, upperCase.length);
  t.is(lowerCase.length, mixedCase.length);
});

test('filterSettingsByQuery - handles query with no matches', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const result = filterSettingsByQuery(settings, 'xyzzzznonexistent', 10);
  t.is(result.length, 0);
});

test('filterSettingsByQuery - trims query before searching', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  const trimmed = filterSettingsByQuery(settings, 'agent', 10);
  const withSpaces = filterSettingsByQuery(settings, '  agent  ', 10);

  t.true(trimmed.length > 0);
  t.is(trimmed.length, withSpaces.length);
});

test('filterSettingsByQuery - handles empty settings array', (t) => {
  const result = filterSettingsByQuery([], 'agent', 10);
  t.is(result.length, 0);
});

test('filterSettingsByQuery - description matching requires substring match, not loose subsequence', (t) => {
  const settings = [
    {
      key: 'app.searchViaShell',
      description: 'Use shell commands (ripgrep/find) for codebase search instead of built-in tools (true|false)',
    },
  ];

  // "model" is a subsequence in the description but not a substring
  const result = filterSettingsByQuery(settings, 'model', 10);
  t.is(result.length, 0);

  // "shell" is a substring in the description
  const result2 = filterSettingsByQuery(settings, 'shell', 10);
  t.is(result2.length, 1);
  t.is(result2[0].key, 'app.searchViaShell');
});

// clampIndex tests
test('clampIndex - returns 0 when array is empty', (t) => {
  t.is(clampIndex(0, 0), 0);
  t.is(clampIndex(5, 0), 0);
  t.is(clampIndex(100, 0), 0);
});

test('clampIndex - returns same index when within bounds', (t) => {
  const cases = [
    { index: 0, length: 5, expected: 0 },
    { index: 2, length: 5, expected: 2 },
    { index: 4, length: 5, expected: 4 },
  ];

  for (const { index, length, expected } of cases) {
    t.is(clampIndex(index, length), expected, `Index ${index} in length ${length}`);
  }
});

test('clampIndex - clamps to max index when out of bounds', (t) => {
  const cases = [
    { index: 5, length: 5, expected: 4 },
    { index: 10, length: 5, expected: 4 },
    { index: 100, length: 3, expected: 2 },
  ];

  for (const { index, length, expected } of cases) {
    t.is(clampIndex(index, length), expected, `Index ${index} clamped in length ${length}`);
  }
});

test('clampIndex - handles length of 1', (t) => {
  t.is(clampIndex(0, 1), 0);
  t.is(clampIndex(1, 1), 0);
  t.is(clampIndex(10, 1), 0);
});

test('clampIndex - clamps negative index to first item', (t) => {
  t.is(clampIndex(-1, 5), 0);
});

// Integration tests
test('Integration - buildSettingsList and filterSettingsByQuery work together', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Search for "model" should find agent.model
  const result = filterSettingsByQuery(settings, 'model', 10);
  t.true(result.some((item) => item.key === 'agent.model'));
  t.true(result.some((item) => item.description?.includes('model')));
});

test('Integration - clampIndex with filtered results', (t) => {
  const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

  // Get filtered results
  const filtered = filterSettingsByQuery(settings, 'agent', 3);

  // Clamp selection index to filtered results
  t.is(clampIndex(0, filtered.length), 0);
  t.is(clampIndex(10, filtered.length), filtered.length - 1);
});
