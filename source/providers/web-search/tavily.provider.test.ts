import test from 'ava';
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

test('tavilyProvider has correct id and label', (t) => {
  t.is(tavilyProvider.id, 'tavily');
  t.is(tavilyProvider.label, 'Tavily');
});

test('tavilyProvider has required methods', (t) => {
  t.is(typeof tavilyProvider.search, 'function');
  t.is(typeof tavilyProvider.isConfigured, 'function');
});

test('tavilyProvider has sensitiveSettingKeys', (t) => {
  t.true(Array.isArray(tavilyProvider.sensitiveSettingKeys));
  t.true(tavilyProvider.sensitiveSettingKeys?.includes('webSearch.tavily.apiKey'));
});

test('isConfigured returns true when API key is set', (t) => {
  const settings = createMockSettingsService({
    'webSearch.tavily.apiKey': 'tvly-test-key',
  });

  const result = isTavilyConfigured({ settingsService: settings });
  t.true(result);
});

test('isConfigured returns false when API key is missing', (t) => {
  const settings = createMockSettingsService({});

  const result = isTavilyConfigured({ settingsService: settings });
  t.false(result);
});

test('isConfigured returns false when API key is empty string', (t) => {
  const settings = createMockSettingsService({
    'webSearch.tavily.apiKey': '',
  });

  const result = isTavilyConfigured({ settingsService: settings });
  t.false(result);
});

test('search throws error when API key is missing', async (t) => {
  const settings = createMockSettingsService({});
  const logging = createMockLoggingService();

  const error = await t.throwsAsync(
    tavilyProvider.search('test query', {
      settingsService: settings,
      loggingService: logging,
    }),
  );

  t.true(error?.message.includes('Tavily API key is not configured'));
});

test('tavilyProvider.isConfigured uses the same logic as isTavilyConfigured', (t) => {
  const settingsWithKey = createMockSettingsService({
    'webSearch.tavily.apiKey': 'tvly-test-key',
  });
  const settingsWithoutKey = createMockSettingsService({});

  t.is(
    tavilyProvider.isConfigured({ settingsService: settingsWithKey }),
    isTavilyConfigured({ settingsService: settingsWithKey }),
  );
  t.is(
    tavilyProvider.isConfigured({ settingsService: settingsWithoutKey }),
    isTavilyConfigured({ settingsService: settingsWithoutKey }),
  );
});
