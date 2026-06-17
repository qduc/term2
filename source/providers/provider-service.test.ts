import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  PROVIDER_NAME_REGEX,
  PROVIDER_TYPES,
  validateWizardName,
  validateWizardUrl,
  isProviderBuiltIn,
  getProviderLabel,
  hasProviderNameConflict,
  getConfiguredProviderNames,
  loadProviderItems,
  saveProvider,
  deleteCustomProvider,
} from './provider-service.js';

function createMockSettingsService(initialProviders: any[] = [], initialActive = 'openai') {
  const settings = new Map<string, any>([
    ['providers', initialProviders],
    ['agent.provider', initialActive],
  ]);

  return {
    get: (key: string) => settings.get(key),
    set: (key: string, value: any) => settings.set(key, value),
    setPersistent: (key: string, value: any) => settings.set(key, value),
  } as any;
}

it('PROVIDER_NAME_REGEX', () => {
  expect(PROVIDER_NAME_REGEX.test('my-provider')).toBe(true);
  expect(PROVIDER_NAME_REGEX.test('my_provider')).toBe(true);
  expect(PROVIDER_NAME_REGEX.test('my.provider')).toBe(true);
  expect(PROVIDER_NAME_REGEX.test('my-provider-2')).toBe(true);
  expect(PROVIDER_NAME_REGEX.test('a')).toBe(true);
  expect(PROVIDER_NAME_REGEX.test('-starts-with-hyphen')).toBe(false);
  expect(PROVIDER_NAME_REGEX.test('_starts-with-underscore')).toBe(false);
  expect(PROVIDER_NAME_REGEX.test('.starts-with-dot')).toBe(false);
  expect(PROVIDER_NAME_REGEX.test('has space')).toBe(false);
  expect(PROVIDER_NAME_REGEX.test('has/slash')).toBe(false);
  expect(PROVIDER_NAME_REGEX.test('')).toBe(false);
});

it('PROVIDER_TYPES contains expected types', () => {
  expect(PROVIDER_TYPES.includes('openai-compatible')).toBe(true);
  expect(PROVIDER_TYPES.includes('openai')).toBe(true);
  expect(PROVIDER_TYPES.includes('llama.cpp')).toBe(true);
  expect(PROVIDER_TYPES.includes('anthropic')).toBe(true);
  expect(PROVIDER_TYPES.includes('google')).toBe(true);
  expect(PROVIDER_TYPES.includes('opencode')).toBe(true);
  expect(PROVIDER_TYPES.length).toBe(6);
});

it('validateWizardName rejects empty name', () => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('', settingsService, false);
  expect(result.valid).toBe(false);
  expect(result.errorMessage).toBe('Name cannot be empty.');
});

it('validateWizardName rejects whitespace-only name', () => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('   ', settingsService, false);
  expect(result.valid).toBe(false);
  expect(result.errorMessage).toBe('Name cannot be empty.');
});

it('validateWizardName rejects invalid format', () => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('my provider', settingsService, false);
  expect(result.valid).toBe(false);
  expect(result.errorMessage!.includes('start with a letter or number')).toBe(true);
});

it('validateWizardName rejects name conflict', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = validateWizardName('openai', settingsService, false);
  expect(result.valid).toBe(false);
  expect(result.errorMessage!.includes('already exists')).toBe(true);
});

it('validateWizardName allows current name when editing', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'existing', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = validateWizardName('existing', settingsService, true, 'existing');
  expect(result.valid).toBe(true);
});

it('validateWizardName accepts valid unique name', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = validateWizardName('my-custom-provider', settingsService, false);
  expect(result.valid).toBe(true);
  expect(result.errorMessage).toBe(undefined);
});

it('validateWizardUrl rejects missing required base URL', () => {
  const result = validateWizardUrl('', 'openai-compatible');
  expect(result.valid).toBe(false);
  expect(result.errorMessage!.includes('Base URL is required')).toBe(true);
});

it('validateWizardUrl rejects invalid URL format', () => {
  const result = validateWizardUrl('not-a-url', 'openai-compatible');
  expect(result.valid).toBe(false);
  expect(result.errorMessage).toBe('Invalid URL format. Make sure it starts with http:// or https://');
});

it('validateWizardUrl accepts valid URL', () => {
  const result = validateWizardUrl('http://localhost:11434/v1', 'openai-compatible');
  expect(result.valid).toBe(true);
});

it('validateWizardUrl accepts empty URL for types that do not require it', () => {
  const result = validateWizardUrl('', 'anthropic');
  expect(result.valid).toBe(true);
});

it('validateWizardUrl accepts empty URL for opencode type', () => {
  const result = validateWizardUrl('', 'opencode');
  expect(result.valid).toBe(true);
});

it('isProviderBuiltIn for known built-in provider', () => {
  // 'openai' is registered in the global registry by module imports
  expect(isProviderBuiltIn('openai')).toBe(true);
});

it('isProviderBuiltIn for non-existent provider returns false', () => {
  expect(isProviderBuiltIn('non-existent-provider')).toBe(false);
});

it('getProviderLabel for known built-in provider', () => {
  expect(getProviderLabel('openai')).toBe('OpenAI');
});

it('getProviderLabel for non-existent provider returns undefined', () => {
  expect(getProviderLabel('non-existent')).toBe(undefined);
});

it('hasProviderNameConflict detects conflict', () => {
  const settingsService = createMockSettingsService([], 'openai');
  expect(hasProviderNameConflict(settingsService, 'openai')).toBe(true);
});

it('hasProviderNameConflict does not flag current name', () => {
  const settingsService = createMockSettingsService([], 'openai');
  expect(hasProviderNameConflict(settingsService, 'openai', 'openai')).toBe(false);
});

it('hasProviderNameConflict detects custom provider conflict', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  expect(hasProviderNameConflict(settingsService, 'custom-ollama')).toBe(true);
});

it('hasProviderNameConflict returns false for empty candidate', () => {
  const settingsService = createMockSettingsService([], 'openai');
  expect(hasProviderNameConflict(settingsService, '')).toBe(false);
});

it('getConfiguredProviderNames includes built-in and custom names', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  const names = getConfiguredProviderNames(settingsService);
  expect(names.has('openai')).toBe(true);
  expect(names.has('custom-ollama')).toBe(true);
});

it('loadProviderItems includes built-in providers without custom flag', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const items = loadProviderItems(settingsService);
  const openai = items.find((i) => i.id === 'openai');
  expect(openai).toBeTruthy();
  expect(openai!.isCustom).toBe(false);
  expect(openai!.isActive).toBe(true);
});

it('loadProviderItems includes custom providers with custom flag', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  const items = loadProviderItems(settingsService);
  const custom = items.find((i) => i.id === 'custom-ollama');
  expect(custom).toBeTruthy();
  expect(custom!.isCustom).toBe(true);
  expect(custom!.isActive).toBe(false);
});

it('loadProviderItems marks active provider correctly', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'custom-ollama',
  );
  const items = loadProviderItems(settingsService);
  const custom = items.find((i) => i.id === 'custom-ollama');
  expect(custom!.isActive).toBe(true);
  const openai = items.find((i) => i.id === 'openai');
  expect(openai!.isActive).toBe(false);
});

it('loadProviderItems ensures active provider is present even if not otherwise collected', () => {
  const settingsService = createMockSettingsService([], 'some-unknown-active');
  const items = loadProviderItems(settingsService);
  const active = items.find((i) => i.id === 'some-unknown-active');
  expect(active).toBeTruthy();
  expect(active!.isActive).toBe(true);
});

it('saveProvider validates empty name', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: '', type: 'openai-compatible' }, null);
  expect(result.success).toBe(false);
  expect(result.fieldErrors?.name).toBeTruthy();
});

it('saveProvider validates invalid name format', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'bad name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  expect(result.success).toBe(false);
  expect(result.fieldErrors?.name).toBeTruthy();
});

it('saveProvider validates name conflict', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'openai', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  expect(result.success).toBe(false);
  expect(result.fieldErrors?.name).toBeTruthy();
  expect(result.fieldErrors!.name!.includes('already exists')).toBe(true);
});

it('saveProvider validates required base URL', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'my-provider', type: 'openai-compatible' }, null);
  expect(result.success).toBe(false);
  expect(result.fieldErrors?.baseUrl).toBeTruthy();
});

it('saveProvider succeeds with valid provider', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'my-provider', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  expect(result.success).toBe(true);
  const providers = settingsService.get('providers');
  expect(Array.isArray(providers)).toBe(true);
  expect(providers.length).toBe(1);
  expect(providers[0].name).toBe('my-provider');
});

it('saveProvider succeeds without baseUrl for types that do not require it', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'my-anthropic', type: 'anthropic' }, null);
  expect(result.success).toBe(true);
});

it('saveProvider edits an existing provider', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = saveProvider(
    settingsService,
    { name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:9090/v1' },
    'old-name',
  );
  expect(result.success).toBe(true);
  const providers = settingsService.get('providers');
  expect(providers.length).toBe(1);
  expect(providers[0].name).toBe('old-name');
  expect(providers[0].baseUrl).toBe('http://localhost:9090/v1');
});

it('saveProvider renames an existing provider', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = saveProvider(
    settingsService,
    { name: 'new-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    'old-name',
  );
  expect(result.success).toBe(true);
  const providers = settingsService.get('providers');
  expect(providers.length).toBe(1);
  expect(providers[0].name).toBe('new-name');
});

it('saveProvider saves API key for built-in provider', () => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'OpenAI', type: 'openai', apiKey: 'sk-test-key' }, 'openai');
  expect(result.success).toBe(true);
  expect(settingsService.get('agent.openai.apiKey')).toBe('sk-test-key');
});

it('deleteCustomProvider removes provider from settings and registry', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'custom-ollama',
  );
  deleteCustomProvider(settingsService, 'custom-ollama');
  const providers = settingsService.get('providers');
  expect(providers.length).toBe(0);
  expect(settingsService.get('agent.provider')).toBe('openai');
});

it('deleteCustomProvider does not change active provider when deleting inactive one', () => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  deleteCustomProvider(settingsService, 'custom-ollama');
  expect(settingsService.get('agent.provider')).toBe('openai');
});
