import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  buildSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  isNumberSetting,
  isStringSetting,
  type SettingValueSuggestion,
} from './use-settings-value-completion.js';

it('buildSettingValueSuggestions returns enum suggestions for reasoningEffort', () => {
  const result = buildSettingValueSuggestions('agent.reasoningEffort');
  const values = result.map((r) => r.value);
  expect(values.includes('low')).toBe(true);
  expect(values.includes('medium')).toBe(true);
  expect(values.includes('high')).toBe(true);
  expect(values.includes('xhigh')).toBe(true);
  expect(values.includes('default')).toBe(true);
});

it('buildSettingValueSuggestions returns enum suggestions for shell.autoApproveMode', () => {
  const result = buildSettingValueSuggestions('shell.autoApproveMode');
  const values = result.map((r) => r.value);
  expect(values.includes('off')).toBe(true);
  expect(values.includes('advisory')).toBe(true);
  expect(values.includes('auto')).toBe(true);
});

it('buildSettingValueSuggestions returns enum suggestions for webSearch.provider', () => {
  const result = buildSettingValueSuggestions('webSearch.provider');
  const values = result.map((r) => r.value);
  expect(values.includes('tavily')).toBe(true);
  expect(values.includes('exa')).toBe(true);
});

it('buildSettingValueSuggestions returns boolean suggestions for boolean settings', () => {
  const result = buildSettingValueSuggestions('logging.suppressConsoleOutput');
  expect(result.map((r) => r.value).sort()).toEqual(['false', 'true']);
});

it('filterSettingValueSuggestionsByQuery filters by partial match', () => {
  const suggestions: SettingValueSuggestion[] = [
    { value: 'debug' },
    { value: 'info' },
    { value: 'warn' },
    { value: 'error' },
  ];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'err', 10);

  expect(result.some((r) => r.value === 'error')).toBe(true);
});

it('filterSettingValueSuggestionsByQuery includes custom number value for number settings', () => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '150', 10, 'ui.historySize');

  expect(result.length >= 1).toBe(true);
  expect(result[0]?.value).toBe('150');
  expect(result[0]?.description).toBe('Custom value');
});

it('filterSettingValueSuggestionsByQuery does not include custom number if already present', () => {
  const suggestions: SettingValueSuggestion[] = [{ value: '100' }, { value: '200' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '100', 10, 'ui.historySize');

  expect(result.length >= 1).toBe(true);
  expect(result[0]?.value).toBe('100');
  expect(result[0]?.description).not.toBe('Custom value');
  expect(result.some((r) => r.description === 'Custom value')).toBe(false);
});

it('filterSettingValueSuggestionsByQuery does not include non-number custom values even for number settings', () => {
  const suggestions: SettingValueSuggestion[] = [];
  const result = filterSettingValueSuggestionsByQuery(suggestions, 'abc', 10, 'ui.historySize');

  expect(result.length).toBe(0);
});

it('isNumberSetting returns true for number setting keys', () => {
  expect(isNumberSetting('agent.maxTurns')).toBe(true);
  expect(isNumberSetting('agent.temperature')).toBe(true);
  expect(isNumberSetting('agent.retryAttempts')).toBe(true);
  expect(isNumberSetting('agent.maxParallelToolCalls')).toBe(true);
  expect(isNumberSetting('shell.timeout')).toBe(true);
  expect(isNumberSetting('ui.pasteThreshold')).toBe(true);
  expect(isNumberSetting('ssh.port')).toBe(true);
});

it('isNumberSetting returns false for non-number setting keys', () => {
  expect(isNumberSetting('agent.model')).toBe(false);
  expect(isNumberSetting('agent.provider')).toBe(false);
  expect(isNumberSetting('logging.logLevel')).toBe(false);
  expect(isNumberSetting('app.mentorMode')).toBe(false);
  expect(isNumberSetting('tools.enableEditHealing')).toBe(false);
});

it('isStringSetting returns true for string setting keys', () => {
  expect(isStringSetting('agent.model')).toBe(true);
  expect(isStringSetting('agent.provider')).toBe(true);
  expect(isStringSetting('webSearch.exa.apiKey')).toBe(true);
  expect(isStringSetting('webSearch.tavily.apiKey')).toBe(true);
  expect(isStringSetting('webSearch.provider')).toBe(true);
  expect(isStringSetting('ssh.host')).toBe(true);
  expect(isStringSetting('app.shellPath')).toBe(true);
});

it('isStringSetting returns false for non-string setting keys', () => {
  expect(isStringSetting('agent.maxTurns')).toBe(false);
  expect(isStringSetting('agent.temperature')).toBe(false);
  expect(isStringSetting('ssh.port')).toBe(false);
  expect(isStringSetting('logging.logLevel')).toBe(false);
  expect(isStringSetting('logging.suppressConsoleOutput')).toBe(false);
  expect(isStringSetting('app.mentorMode')).toBe(false);
  expect(isStringSetting('tools.enableEditHealing')).toBe(false);
});

it('filterSettingValueSuggestionsByQuery includes custom string value for string settings without predefined suggestions', () => {
  const suggestions: SettingValueSuggestion[] = [];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'my-api-key', 10, 'webSearch.exa.apiKey');

  expect(result.length >= 1).toBe(true);
  expect(result[0]?.value).toBe('my-api-key');
  expect(result[0]?.description).toBe('Custom value');
});

it('filterSettingValueSuggestionsByQuery does not include custom string if already present', () => {
  const suggestions: SettingValueSuggestion[] = [{ value: 'current-key', description: 'Current value' }];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'current-key', 10, 'webSearch.exa.apiKey');

  expect(result.length >= 1).toBe(true);
  expect(result[0]?.value).toBe('current-key');
  expect(result[0]?.description).not.toBe('Custom value');
  expect(result.some((r) => r.description === 'Custom value')).toBe(false);
});

it('filterSettingValueSuggestionsByQuery does not include custom string for string settings with predefined suggestions', () => {
  const suggestions: SettingValueSuggestion[] = [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ];

  const result = filterSettingValueSuggestionsByQuery(suggestions, 'custom-provider', 10, 'agent.provider');

  expect(result.some((r) => r.description === 'Custom value')).toBe(false);
});

it('filterSettingValueSuggestionsByQuery does not include custom string for empty query', () => {
  const suggestions: SettingValueSuggestion[] = [];

  const result = filterSettingValueSuggestionsByQuery(suggestions, '', 10, 'webSearch.exa.apiKey');

  expect(result.some((r) => r.description === 'Custom value')).toBe(false);
});

it('buildSettingValueSuggestions returns no predefined values for free-form API key settings', () => {
  expect(buildSettingValueSuggestions('webSearch.exa.apiKey')).toEqual([]);
  expect(buildSettingValueSuggestions('webSearch.tavily.apiKey')).toEqual([]);
});

it('buildSettingValueSuggestions returns enum suggestions for ui.displayMode', () => {
  const result = buildSettingValueSuggestions('ui.displayMode');
  const values = result.map((r) => r.value);
  expect(values).toEqual(['standard', 'concise']);
});

it('buildSettingValueSuggestions returns transport suggestions', () => {
  expect(buildSettingValueSuggestions('agent.transport').map((suggestion) => suggestion.value)).toEqual([
    'websocket',
    'http',
  ]);
});
