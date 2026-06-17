import { it, expect } from 'vitest';
import { tavilyProvider, isTavilyConfigured } from './tavily.provider.js';

// Helper to create a mock settings service
const createMockSettingsService = (settings: Record<string, any> = {}) => ({
  get: <T>(key: string): T => settings[key] as T,
  set: () => {},
});

// Helper to create a mock logging service
const createMockLoggingService = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
});

it('tavilyProvider has correct id and label', () => {
  expect(tavilyProvider.id).toBe('tavily');
  expect(tavilyProvider.label).toBe('Tavily');
});

it('tavilyProvider has required methods', () => {
  expect(typeof tavilyProvider.search).toBe('function');
  expect(typeof tavilyProvider.isConfigured).toBe('function');
});

it('tavilyProvider has sensitiveSettingKeys', () => {
  expect(Array.isArray(tavilyProvider.sensitiveSettingKeys)).toBe(true);
  expect(tavilyProvider.sensitiveSettingKeys?.includes('webSearch.tavily.apiKey')).toBe(true);
});

it('isConfigured returns true when API key is set', () => {
  const settings = createMockSettingsService({
    'webSearch.tavily.apiKey': 'tvly-test-key',
  });

  const result = isTavilyConfigured({ settingsService: settings });
  expect(result).toBe(true);
});

it('isConfigured returns false when API key is missing', () => {
  const settings = createMockSettingsService({});

  const result = isTavilyConfigured({ settingsService: settings });
  expect(result).toBe(false);
});

it('isConfigured returns false when API key is empty string', () => {
  const settings = createMockSettingsService({
    'webSearch.tavily.apiKey': '',
  });

  const result = isTavilyConfigured({ settingsService: settings });
  expect(result).toBe(false);
});

it('search throws error when API key is missing', async () => {
  const settings = createMockSettingsService({});
  const logging = createMockLoggingService();

  await expect(
    tavilyProvider.search('test query', {
      settingsService: settings,
      loggingService: logging,
    }),
  ).rejects.toThrow(/Tavily API key is not configured/);
});

it('tavilyProvider.isConfigured uses the same logic as isTavilyConfigured', () => {
  const settingsWithKey = createMockSettingsService({
    'webSearch.tavily.apiKey': 'tvly-test-key',
  });
  const settingsWithoutKey = createMockSettingsService({});

  expect(tavilyProvider.isConfigured({ settingsService: settingsWithKey })).toBe(
    isTavilyConfigured({ settingsService: settingsWithKey }),
  );
  expect(tavilyProvider.isConfigured({ settingsService: settingsWithoutKey })).toBe(
    isTavilyConfigured({ settingsService: settingsWithoutKey }),
  );
});
