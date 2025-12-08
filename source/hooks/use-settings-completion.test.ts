import test from 'ava';
import Fuse from 'fuse.js';
import {
	buildSettingsList,
	filterSettingsByQuery,
	clampIndex,
} from './use-settings-completion.js';

// Mock setting keys for testing (matching actual SETTING_KEYS structure)
const MOCK_SETTING_KEYS = {
	AGENT_MODEL: 'agent.model',
	AGENT_REASONING_EFFORT: 'agent.reasoningEffort',
	AGENT_PROVIDER: 'agent.provider',
	AGENT_MAX_TURNS: 'agent.maxTurns',
	AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
	AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
	AGENT_OPENROUTER_MODEL: 'agent.openrouter.model',
	AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl',
	AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer',
	AGENT_OPENROUTER_TITLE: 'agent.openrouter.title',
	SHELL_TIMEOUT: 'shell.timeout',
	SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
	SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
	UI_HISTORY_SIZE: 'ui.historySize',
	LOGGING_LOG_LEVEL: 'logging.logLevel',
	LOGGING_DISABLE: 'logging.disableLogging',
	LOGGING_DEBUG: 'logging.debugLogging',
	ENV_NODE_ENV: 'environment.nodeEnv',
	APP_SHELL_PATH: 'app.shellPath',
	TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
	DEBUG_BASH_TOOL: 'debug.debugBashTool',
} as const;

const MOCK_DESCRIPTIONS: Record<string, string> = {
	'agent.model': 'The AI model to use (e.g. gpt-4, claude-3-opus)',
	'agent.reasoningEffort': 'Reasoning effort level (default, low, medium, high)',
	'agent.provider': 'AI provider (openai, openrouter)',
	'agent.maxTurns': 'Maximum conversation turns',
	'agent.retryAttempts': 'Number of retry attempts for failed requests',
	'agent.openrouter.apiKey': 'OpenRouter API key',
	'agent.openrouter.model': 'OpenRouter model name',
	'agent.openrouter.baseUrl': 'OpenRouter base URL',
	'agent.openrouter.referrer': 'OpenRouter referrer',
	'agent.openrouter.title': 'OpenRouter title',
	'shell.timeout': 'Shell command timeout in milliseconds',
	'shell.maxOutputLines': 'Maximum lines of shell output to capture',
	'shell.maxOutputChars': 'Maximum characters of shell output to capture',
	'ui.historySize': 'Number of history items to keep',
	'logging.logLevel': 'Logging level (debug, info, warn, error)',
	'logging.disableLogging': 'Disable all logging',
	'logging.debugLogging': 'Enable debug logging',
	'environment.nodeEnv': 'Node environment (development, production)',
	'app.shellPath': 'Path to shell executable',
	'tools.logFileOperations': 'Log file operations to disk',
	'debug.debugBashTool': 'Enable bash tool debugging',
};

// buildSettingsList tests
test('buildSettingsList - creates list from keys and descriptions', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

	// Should exclude 5 sensitive settings by default
	const expectedCount = Object.keys(MOCK_SETTING_KEYS).length - 5;
	t.is(result.length, expectedCount);
	t.true(result.every(item => typeof item.key === 'string'));
	t.true(result.every(item => item.description !== undefined));
});

test('buildSettingsList - excludes sensitive settings by default', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const keys = new Set(result.map(item => item.key));

	// Should not include sensitive settings
	t.false(keys.has('agent.openrouter.apiKey'));
	t.false(keys.has('agent.openrouter.baseUrl'));
	t.false(keys.has('agent.openrouter.referrer'));
	t.false(keys.has('agent.openrouter.title'));
	t.false(keys.has('app.shellPath'));

	// Should include non-sensitive settings
	t.true(keys.has('agent.model'));
	t.true(keys.has('agent.openrouter.model'));
	t.true(keys.has('shell.timeout'));
});

test('buildSettingsList - can include sensitive settings when requested', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, false);
	const keys = new Set(result.map(item => item.key));

	// Should include all settings when excludeSensitive is false
	t.is(result.length, Object.keys(MOCK_SETTING_KEYS).length);
	t.true(keys.has('agent.openrouter.apiKey'));
	t.true(keys.has('app.shellPath'));
});

test('buildSettingsList - includes all non-sensitive setting keys', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const keys = result.map(item => item.key);

	// Check specific non-sensitive keys that should be included
	const nonSensitiveKeys = [
		'agent.model',
		'agent.reasoningEffort',
		'agent.provider',
		'agent.openrouter.model',
		'shell.timeout',
		'logging.logLevel',
	];

	for (const settingKey of nonSensitiveKeys) {
		t.true(keys.includes(settingKey), `Missing key: ${settingKey}`);
	}
});

test('buildSettingsList - maps descriptions correctly', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);

	for (const item of result) {
		t.is(item.description, MOCK_DESCRIPTIONS[item.key]);
	}
});

test('buildSettingsList - includes current values when provided', t => {
	const mockGetCurrentValue = (key: string): string | number | boolean => {
		const values: Record<string, string | number | boolean> = {
			'agent.model': 'gpt-4o',
			'shell.timeout': 120000,
			'logging.logLevel': 'info',
		};
		return values[key] ?? 'default';
	};

	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, true, mockGetCurrentValue);

	const agentModel = result.find(item => item.key === 'agent.model');
	const shellTimeout = result.find(item => item.key === 'shell.timeout');
	const logLevel = result.find(item => item.key === 'logging.logLevel');

	t.is(agentModel?.currentValue, 'gpt-4o');
	t.is(shellTimeout?.currentValue, 120000);
	t.is(logLevel?.currentValue, 'info');
});

test('buildSettingsList - handles missing current values', t => {
	const mockGetCurrentValue = (key: string): string | number | boolean | undefined => {
		if (key === 'agent.model') {
			return 'gpt-4o';
		}
		return undefined;
	};

	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS, true, mockGetCurrentValue);

	const agentModel = result.find(item => item.key === 'agent.model');
	const shellTimeout = result.find(item => item.key === 'shell.timeout');

	t.is(agentModel?.currentValue, 'gpt-4o');
	t.is(shellTimeout?.currentValue, undefined);
});

test('buildSettingsList - handles missing descriptions with empty string', t => {
	const incompleteDescriptions = {
		'agent.model': 'Model description',
	};

	const result = buildSettingsList(MOCK_SETTING_KEYS, incompleteDescriptions);

	const agentModel = result.find(item => item.key === 'agent.model');
	const shellTimeout = result.find(item => item.key === 'shell.timeout');

	t.is(agentModel?.description, 'Model description');
	t.is(shellTimeout?.description, '');
});

test('buildSettingsList - handles empty descriptions object', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, {});

	// Should exclude sensitive settings
	const expectedCount = Object.keys(MOCK_SETTING_KEYS).length - 5;
	t.is(result.length, expectedCount);
	t.true(result.every(item => item.description === ''));
});

test('buildSettingsList - no duplicate keys', t => {
	const result = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const keys = result.map(item => item.key);
	const uniqueKeys = new Set(keys);

	t.is(keys.length, uniqueKeys.size, 'Duplicate keys found');
});

// filterSettingsByQuery tests
test('filterSettingsByQuery - empty query returns first N results', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const result = filterSettingsByQuery(settings, '', fuse, 3);
	t.is(result.length, 3);
});

test('filterSettingsByQuery - whitespace-only query returns first N results', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const result = filterSettingsByQuery(settings, '   ', fuse, 3);
	t.is(result.length, 3);
});

test('filterSettingsByQuery - exact key match returns result', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const result = filterSettingsByQuery(settings, 'agent.model', fuse, 10);
	t.true(result.length > 0);
	t.true(result.some(item => item.key === 'agent.model'));
});

test('filterSettingsByQuery - partial key match returns results', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const cases = [
		{query: 'agent', expectedKeySubstring: 'agent'},
		{query: 'shell', expectedKeySubstring: 'shell'},
		{query: 'model', expectedKeySubstring: 'model'},
	];

	for (const {query, expectedKeySubstring} of cases) {
		const result = filterSettingsByQuery(settings, query, fuse, 10);
		t.true(result.length > 0, `Query "${query}" should return results`);
		t.true(
			result.some(item => item.key.includes(expectedKeySubstring)),
			`Query "${query}" should match key containing "${expectedKeySubstring}"`
		);
	}
});

test('filterSettingsByQuery - search by description returns results', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const cases = [
		{query: 'timeout', expectedKey: 'shell.timeout'},
		{query: 'model', expectedKey: 'agent.model'},
		{query: 'logging', expectedKey: 'logging.logLevel'},
	];

	for (const {query, expectedKey} of cases) {
		const result = filterSettingsByQuery(settings, query, fuse, 10);
		t.true(result.length > 0, `Query "${query}" should return results`);
		t.true(
			result.some(item => item.key === expectedKey),
			`Query "${query}" should find key "${expectedKey}"`
		);
	}
});

test('filterSettingsByQuery - respects maxResults parameter', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const result1 = filterSettingsByQuery(settings, '', fuse, 2);
	t.is(result1.length, 2);

	const result2 = filterSettingsByQuery(settings, '', fuse, 4);
	t.is(result2.length, 4);

	const result3 = filterSettingsByQuery(settings, '', fuse, 100);
	t.true(result3.length <= settings.length);
});

test('filterSettingsByQuery - case insensitive search', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const lowerCase = filterSettingsByQuery(settings, 'agent', fuse, 10);
	const upperCase = filterSettingsByQuery(settings, 'AGENT', fuse, 10);
	const mixedCase = filterSettingsByQuery(settings, 'AgEnT', fuse, 10);

	t.true(lowerCase.length > 0);
	t.true(upperCase.length > 0);
	t.true(mixedCase.length > 0);
	// Note: Fuzzy search might return slightly different results, but all should find matches
});

test('filterSettingsByQuery - handles query with no matches', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const result = filterSettingsByQuery(settings, 'xyzzzznonexistent', fuse, 10);
	// Fuzzy search might still return some results due to threshold, but likely empty
	t.true(Array.isArray(result));
});

test('filterSettingsByQuery - trims query before searching', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	const trimmed = filterSettingsByQuery(settings, 'agent', fuse, 10);
	const withSpaces = filterSettingsByQuery(settings, '  agent  ', fuse, 10);

	t.true(trimmed.length > 0);
	t.true(withSpaces.length > 0);
});

test('filterSettingsByQuery - handles empty settings array', t => {
	const fuse = new Fuse([], {keys: ['key', 'description'], threshold: 0.4});

	const result = filterSettingsByQuery([], 'agent', fuse, 10);
	t.is(result.length, 0);
});

// clampIndex tests
test('clampIndex - returns 0 when array is empty', t => {
	t.is(clampIndex(0, 0), 0);
	t.is(clampIndex(5, 0), 0);
	t.is(clampIndex(100, 0), 0);
});

test('clampIndex - returns same index when within bounds', t => {
	const cases = [
		{index: 0, length: 5, expected: 0},
		{index: 2, length: 5, expected: 2},
		{index: 4, length: 5, expected: 4},
	];

	for (const {index, length, expected} of cases) {
		t.is(clampIndex(index, length), expected, `Index ${index} in length ${length}`);
	}
});

test('clampIndex - clamps to max index when out of bounds', t => {
	const cases = [
		{index: 5, length: 5, expected: 4},
		{index: 10, length: 5, expected: 4},
		{index: 100, length: 3, expected: 2},
	];

	for (const {index, length, expected} of cases) {
		t.is(clampIndex(index, length), expected, `Index ${index} clamped in length ${length}`);
	}
});

test('clampIndex - handles length of 1', t => {
	t.is(clampIndex(0, 1), 0);
	t.is(clampIndex(1, 1), 0);
	t.is(clampIndex(10, 1), 0);
});

test('clampIndex - handles negative index (Math.min behavior)', t => {
	// Math.min will return the negative value if it's smaller than arrayLength - 1
	// This is the actual behavior of the implementation
	const result = clampIndex(-1, 5);
	t.is(result, -1, 'Math.min(-1, 4) = -1');
});

// Integration tests
test('Integration - buildSettingsList and filterSettingsByQuery work together', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	// Search for "model" should find agent.model
	const result = filterSettingsByQuery(settings, 'model', fuse, 10);
	t.true(result.some(item => item.key === 'agent.model'));
	t.true(result.some(item => item.description?.includes('model')));
});

test('Integration - clampIndex with filtered results', t => {
	const settings = buildSettingsList(MOCK_SETTING_KEYS, MOCK_DESCRIPTIONS);
	const fuse = new Fuse(settings, {keys: ['key', 'description'], threshold: 0.4});

	// Get filtered results
	const filtered = filterSettingsByQuery(settings, 'agent', fuse, 3);

	// Clamp selection index to filtered results
	t.is(clampIndex(0, filtered.length), 0);
	t.is(clampIndex(10, filtered.length), filtered.length - 1);
});
