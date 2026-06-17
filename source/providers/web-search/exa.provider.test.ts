import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { exaProvider, isExaConfigured } from './exa.provider.js';

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

it('exaProvider has correct id and label', () => {
  expect(exaProvider.id).toBe('exa');
  expect(exaProvider.label).toBe('Exa');
});

it('exaProvider has required methods', () => {
  expect(typeof exaProvider.search).toBe('function');
  expect(typeof exaProvider.isConfigured).toBe('function');
});

it('exaProvider has sensitiveSettingKeys', () => {
  expect(Array.isArray(exaProvider.sensitiveSettingKeys)).toBe(true);
  expect(exaProvider.sensitiveSettingKeys?.includes('webSearch.exa.apiKey')).toBe(true);
});

it('isConfigured returns true when API key is set', () => {
  const settings = createMockSettingsService({
    'webSearch.exa.apiKey': 'exa-test-key',
  });

  const result = isExaConfigured({ settingsService: settings });
  expect(result).toBe(true);
});

it('isConfigured returns false when API key is missing', () => {
  const settings = createMockSettingsService({});

  const result = isExaConfigured({ settingsService: settings });
  expect(result).toBe(false);
});

it('isConfigured returns false when API key is empty string', () => {
  const settings = createMockSettingsService({
    'webSearch.exa.apiKey': '',
  });

  const result = isExaConfigured({ settingsService: settings });
  expect(result).toBe(false);
});

it('search throws error when API key is missing', async () => {
  const settings = createMockSettingsService({});
  const logging = createMockLoggingService();

  await expect(
    exaProvider.search('test query', {
      settingsService: settings,
      loggingService: logging,
    }),
  ).rejects.toThrow(/Exa API key is not configured/);
});

it('exaProvider.isConfigured uses the same logic as isExaConfigured', () => {
  const settingsWithKey = createMockSettingsService({
    'webSearch.exa.apiKey': 'exa-test-key',
  });
  const settingsWithoutKey = createMockSettingsService({});

  expect(exaProvider.isConfigured({ settingsService: settingsWithKey })).toBe(
    isExaConfigured({ settingsService: settingsWithKey }),
  );
  expect(exaProvider.isConfigured({ settingsService: settingsWithoutKey })).toBe(
    isExaConfigured({ settingsService: settingsWithoutKey }),
  );
});
