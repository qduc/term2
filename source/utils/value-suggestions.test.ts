import { it, expect } from 'vitest';
import {
  buildSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  type SettingValueSuggestion,
} from './value-suggestions.js';
import { resolveSettingAtPath, unwrapSchema } from '../services/settings/setting-schema-utils.js';
import { SettingsSchema } from '../services/settings/settings-schema.js';
import { z } from 'zod';

/**
 * Walk the SettingsSchema and collect all setting keys whose leaf schema is
 * an enum or boolean (after unwrapping optional/default/effects wrappers).
 */
function collectEnumAndBooleanKeys(): string[] {
  const keys: string[] = [];
  const shape = (SettingsSchema as any)._def?.shape;
  for (const [section, sectionSchema] of Object.entries(shape ?? {})) {
    const innerShape = unwrapSchema(sectionSchema)?._def?.shape;
    if (!innerShape) continue;
    for (const [field, fieldSchema] of Object.entries(innerShape)) {
      const unwrapped = unwrapSchema(fieldSchema);
      if (!unwrapped) continue;
      const def = (unwrapped as any)._def ?? (unwrapped as any).def;
      if (!def) continue;
      const typeName = def.type ?? def.typeName;
      const isEnum =
        typeName === 'enum' || typeName === 'ZodEnum' || typeName === 'literal' || typeName === 'ZodLiteral';
      const isBool = typeName === 'boolean' || typeName === 'ZodBoolean';
      if (isEnum || isBool) {
        keys.push(`${section}.${field}`);
      }
    }
  }
  return keys;
}

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

it('every enum/boolean setting has auto-generated suggestions', () => {
  const keys = collectEnumAndBooleanKeys();
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    const suggestions = buildSettingValueSuggestions(key);
    expect(suggestions.length).toBeGreaterThan(0);
  }
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
  const numberKeys = [
    'agent.maxTurns',
    'agent.temperature',
    'agent.retryAttempts',
    'agent.maxParallelToolCalls',
    'shell.timeout',
    'ui.pasteThreshold',
    'ssh.port',
  ];
  for (const key of numberKeys) {
    const schema = resolveSettingAtPath(key);
    const unwrapped = unwrapSchema(schema);
    expect(unwrapped).toBeInstanceOf(z.ZodNumber);
  }
});

it('isNumberSetting returns false for non-number setting keys', () => {
  const nonNumberKeys = [
    'agent.model',
    'agent.provider',
    'logging.logLevel',
    'app.mentorMode',
    'tools.enableEditHealing',
  ];
  for (const key of nonNumberKeys) {
    const schema = resolveSettingAtPath(key);
    const unwrapped = unwrapSchema(schema);
    expect(unwrapped).not.toBeInstanceOf(z.ZodNumber);
  }
});

it('isStringSetting returns true for string setting keys', () => {
  const stringKeys = [
    'agent.model',
    'agent.provider',
    'webSearch.exa.apiKey',
    'webSearch.tavily.apiKey',
    'webSearch.provider',
    'ssh.host',
    'app.shellPath',
  ];
  for (const key of stringKeys) {
    const schema = resolveSettingAtPath(key);
    const unwrapped = unwrapSchema(schema);
    expect(unwrapped).toBeInstanceOf(z.ZodString);
  }
});

it('isStringSetting returns false for non-string setting keys', () => {
  const nonStringKeys = [
    'agent.maxTurns',
    'agent.temperature',
    'ssh.port',
    'logging.logLevel',
    'logging.suppressConsoleOutput',
    'app.mentorMode',
    'tools.enableEditHealing',
  ];
  for (const key of nonStringKeys) {
    const schema = resolveSettingAtPath(key);
    const unwrapped = unwrapSchema(schema);
    expect(unwrapped).not.toBeInstanceOf(z.ZodString);
  }
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
