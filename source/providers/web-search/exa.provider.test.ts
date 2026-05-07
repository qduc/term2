import test from 'ava';
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

test('exaProvider has correct id and label', (t) => {
  t.is(exaProvider.id, 'exa');
  t.is(exaProvider.label, 'Exa');
});

test('exaProvider has required methods', (t) => {
  t.is(typeof exaProvider.search, 'function');
  t.is(typeof exaProvider.isConfigured, 'function');
});

test('exaProvider has sensitiveSettingKeys', (t) => {
  t.true(Array.isArray(exaProvider.sensitiveSettingKeys));
  t.true(exaProvider.sensitiveSettingKeys?.includes('webSearch.exa.apiKey'));
});

test('isConfigured returns true when API key is set', (t) => {
  const settings = createMockSettingsService({
    'webSearch.exa.apiKey': 'exa-test-key',
  });

  const result = isExaConfigured({ settingsService: settings });
  t.true(result);
});

test('isConfigured returns false when API key is missing', (t) => {
  const settings = createMockSettingsService({});

  const result = isExaConfigured({ settingsService: settings });
  t.false(result);
});

test('isConfigured returns false when API key is empty string', (t) => {
  const settings = createMockSettingsService({
    'webSearch.exa.apiKey': '',
  });

  const result = isExaConfigured({ settingsService: settings });
  t.false(result);
});

test('search throws error when API key is missing', async (t) => {
  const settings = createMockSettingsService({});
  const logging = createMockLoggingService();

  const error = await t.throwsAsync(
    exaProvider.search('test query', {
      settingsService: settings,
      loggingService: logging,
    }),
  );

  t.true(error?.message.includes('Exa API key is not configured'));
});

test('exaProvider.isConfigured uses the same logic as isExaConfigured', (t) => {
  const settingsWithKey = createMockSettingsService({
    'webSearch.exa.apiKey': 'exa-test-key',
  });
  const settingsWithoutKey = createMockSettingsService({});

  t.is(
    exaProvider.isConfigured({ settingsService: settingsWithKey }),
    isExaConfigured({ settingsService: settingsWithKey }),
  );
  t.is(
    exaProvider.isConfigured({ settingsService: settingsWithoutKey }),
    isExaConfigured({ settingsService: settingsWithoutKey }),
  );
});
