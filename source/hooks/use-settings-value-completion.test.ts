import test from 'ava';
import {
  buildSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  isNumberSetting,
  isStringSetting,
  type SettingValueSuggestion,
} from './use-settings-value-completion.js';

test('buildSettingValueSuggestions returns enum suggestions for reasoningEffort', (t) => {
  const result = buildSettingValueSuggestions('agent.reasoningEffort');
  const values = result.map((r) => r.value);
  t.true(values.includes('low'));
  t.true(values.includes('medium'));
  t.true(values.includes('high'));
  t.true(values.includes('xhigh'));
  t.true(values.includes('default'));
});

test('buildSettingValueSuggestions returns enum suggestions for shell.autoApproveMode', (t) => {
  const result = buildSettingValueSuggestions('shell.autoApproveMode');
  const values = result.map((r) => r.value);
  t.true(values.includes('off'));
  t.true(values.includes('advisory'));
  t.true(values.includes('auto'));
});

test('buildSettingValueSuggestions returns enum suggestions for webSearch.provider', (t) => {
  const result = buildSettingValueSuggestions('webSearch.provider');
  const values = result.map((r) => r.value);
  t.true(values.includes('tavily'));
  t.true(values.includes('exa'));
});

test('buildSettingValueSuggestions returns boolean suggestions for boolean settings', (t) => {
  const result = buildSettingValueSuggestions('logging.suppressConsoleOutput');
  t.deepEqual(result.map((r) => r.value).sort(), ['false', 'true']);
});

test('filterSettingValueSuggestionsByQuery filters by partial match', (t) => {
  const suggestions: SettingValueSuggestion[] = [
    { value: 'debug' },
    { value: 'info' },
    { value: 'warn' },
    { value: 'error' },
  ];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'err', 10);

  t.true(result.some((r) => r.value === 'error'));
});

test('filterSettingValueSuggestionsByQuery includes custom number value for number settings', (t) => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '150', 10, 'ui.historySize');

  t.true(result.length >= 1);
  t.is(result[0]?.value, '150');
  t.is(result[0]?.description, 'Custom value');
});

test('filterSettingValueSuggestionsByQuery does not include custom number if already present', (t) => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '100', 10, 'ui.historySize');

  t.true(result.length >= 1);
  t.is(result[0]?.value, '100');
  t.not(result[0]?.description, 'Custom value');
  t.false(result.some((r) => r.description === 'Custom value'));
});

test('filterSettingValueSuggestionsByQuery does not include non-number custom values even for number settings', (t) => {
  const suggestions: SettingValueSuggestion[] = [];
  const result = filterSettingValueSuggestionsByQuery(suggestions, 'abc', 10, 'ui.historySize');

  t.is(result.length, 0);
});

test('isNumberSetting returns true for number setting keys', (t) => {
  t.true(isNumberSetting('agent.maxTurns'));
  t.true(isNumberSetting('agent.temperature'));
  t.true(isNumberSetting('agent.retryAttempts'));
  t.true(isNumberSetting('agent.maxParallelToolCalls'));
  t.true(isNumberSetting('shell.timeout'));
  t.true(isNumberSetting('ui.pasteThreshold'));
  t.true(isNumberSetting('ssh.port'));
});

test('isNumberSetting returns false for non-number setting keys', (t) => {
  t.false(isNumberSetting('agent.model'));
  t.false(isNumberSetting('agent.provider'));
  t.false(isNumberSetting('logging.logLevel'));
  t.false(isNumberSetting('app.mentorMode'));
  t.false(isNumberSetting('tools.enableEditHealing'));
});

test('isStringSetting returns true for string setting keys', (t) => {
  t.true(isStringSetting('agent.model'));
  t.true(isStringSetting('agent.provider'));
  t.true(isStringSetting('webSearch.exa.apiKey'));
  t.true(isStringSetting('webSearch.tavily.apiKey'));
  t.true(isStringSetting('webSearch.provider'));
  t.true(isStringSetting('ssh.host'));
  t.true(isStringSetting('app.shellPath'));
});

test('isStringSetting returns false for non-string setting keys', (t) => {
  t.false(isStringSetting('agent.maxTurns'));
  t.false(isStringSetting('agent.temperature'));
  t.false(isStringSetting('ssh.port'));
  t.false(isStringSetting('logging.logLevel'));
  t.false(isStringSetting('logging.suppressConsoleOutput'));
  t.false(isStringSetting('app.mentorMode'));
  t.false(isStringSetting('tools.enableEditHealing'));
});

test('filterSettingValueSuggestionsByQuery includes custom string value for string settings without predefined suggestions', (t) => {
  const suggestions: SettingValueSuggestion[] = [];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'my-api-key', 10, 'webSearch.exa.apiKey');

  t.true(result.length >= 1);
  t.is(result[0]?.value, 'my-api-key');
  t.is(result[0]?.description, 'Custom value');
});

test('filterSettingValueSuggestionsByQuery does not include custom string if already present', (t) => {
  const suggestions: SettingValueSuggestion[] = [{ value: 'current-key', description: 'Current value' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'current-key', 10, 'webSearch.exa.apiKey');

  t.true(result.length >= 1);
  t.is(result[0]?.value, 'current-key');
  t.not(result[0]?.description, 'Custom value');
  t.false(result.some((r) => r.description === 'Custom value'));
});

test('filterSettingValueSuggestionsByQuery does not include custom string for string settings with predefined suggestions', (t) => {
  const suggestions: SettingValueSuggestion[] = [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'custom-provider', 10, 'agent.provider');

  t.false(result.some((r) => r.description === 'Custom value'));
});

test('filterSettingValueSuggestionsByQuery does not include custom string for empty query', (t) => {
  const suggestions: SettingValueSuggestion[] = [];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '', 10, 'webSearch.exa.apiKey');

  t.false(result.some((r) => r.description === 'Custom value'));
});

test('buildSettingValueSuggestions returns no predefined values for free-form API key settings', (t) => {
  t.deepEqual(buildSettingValueSuggestions('webSearch.exa.apiKey'), []);
  t.deepEqual(buildSettingValueSuggestions('webSearch.tavily.apiKey'), []);
});
