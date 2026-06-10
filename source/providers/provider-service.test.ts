import test from 'ava';
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

test('PROVIDER_NAME_REGEX', (t) => {
  t.true(PROVIDER_NAME_REGEX.test('my-provider'));
  t.true(PROVIDER_NAME_REGEX.test('my_provider'));
  t.true(PROVIDER_NAME_REGEX.test('my.provider'));
  t.true(PROVIDER_NAME_REGEX.test('my-provider-2'));
  t.true(PROVIDER_NAME_REGEX.test('a'));
  t.false(PROVIDER_NAME_REGEX.test('-starts-with-hyphen'));
  t.false(PROVIDER_NAME_REGEX.test('_starts-with-underscore'));
  t.false(PROVIDER_NAME_REGEX.test('.starts-with-dot'));
  t.false(PROVIDER_NAME_REGEX.test('has space'));
  t.false(PROVIDER_NAME_REGEX.test('has/slash'));
  t.false(PROVIDER_NAME_REGEX.test(''));
});

test('PROVIDER_TYPES contains expected types', (t) => {
  t.true(PROVIDER_TYPES.includes('openai-compatible'));
  t.true(PROVIDER_TYPES.includes('openai'));
  t.true(PROVIDER_TYPES.includes('llama.cpp'));
  t.true(PROVIDER_TYPES.includes('anthropic'));
  t.true(PROVIDER_TYPES.includes('google'));
  t.true(PROVIDER_TYPES.includes('opencode'));
  t.is(PROVIDER_TYPES.length, 6);
});

test('validateWizardName rejects empty name', (t) => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('', settingsService, false);
  t.false(result.valid);
  t.is(result.errorMessage, 'Name cannot be empty.');
});

test('validateWizardName rejects whitespace-only name', (t) => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('   ', settingsService, false);
  t.false(result.valid);
  t.is(result.errorMessage, 'Name cannot be empty.');
});

test('validateWizardName rejects invalid format', (t) => {
  const settingsService = createMockSettingsService();
  const result = validateWizardName('my provider', settingsService, false);
  t.false(result.valid);
  t.true(result.errorMessage!.includes('start with a letter or number'));
});

test('validateWizardName rejects name conflict', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = validateWizardName('openai', settingsService, false);
  t.false(result.valid);
  t.true(result.errorMessage!.includes('already exists'));
});

test('validateWizardName allows current name when editing', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'existing', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = validateWizardName('existing', settingsService, true, 'existing');
  t.true(result.valid);
});

test('validateWizardName accepts valid unique name', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = validateWizardName('my-custom-provider', settingsService, false);
  t.true(result.valid);
  t.is(result.errorMessage, undefined);
});

test('validateWizardUrl rejects missing required base URL', (t) => {
  const result = validateWizardUrl('', 'openai-compatible');
  t.false(result.valid);
  t.true(result.errorMessage!.includes('Base URL is required'));
});

test('validateWizardUrl rejects invalid URL format', (t) => {
  const result = validateWizardUrl('not-a-url', 'openai-compatible');
  t.false(result.valid);
  t.is(result.errorMessage, 'Invalid URL format. Make sure it starts with http:// or https://');
});

test('validateWizardUrl accepts valid URL', (t) => {
  const result = validateWizardUrl('http://localhost:11434/v1', 'openai-compatible');
  t.true(result.valid);
});

test('validateWizardUrl accepts empty URL for types that do not require it', (t) => {
  const result = validateWizardUrl('', 'anthropic');
  t.true(result.valid);
});

test('validateWizardUrl accepts empty URL for opencode type', (t) => {
  const result = validateWizardUrl('', 'opencode');
  t.true(result.valid);
});

test('isProviderBuiltIn for known built-in provider', (t) => {
  // 'openai' is registered in the global registry by module imports
  t.true(isProviderBuiltIn('openai'));
});

test('isProviderBuiltIn for non-existent provider returns false', (t) => {
  t.false(isProviderBuiltIn('non-existent-provider'));
});

test('getProviderLabel for known built-in provider', (t) => {
  t.is(getProviderLabel('openai'), 'OpenAI');
});

test('getProviderLabel for non-existent provider returns undefined', (t) => {
  t.is(getProviderLabel('non-existent'), undefined);
});

test('hasProviderNameConflict detects conflict', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  t.true(hasProviderNameConflict(settingsService, 'openai'));
});

test('hasProviderNameConflict does not flag current name', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  t.false(hasProviderNameConflict(settingsService, 'openai', 'openai'));
});

test('hasProviderNameConflict detects custom provider conflict', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  t.true(hasProviderNameConflict(settingsService, 'custom-ollama'));
});

test('hasProviderNameConflict returns false for empty candidate', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  t.false(hasProviderNameConflict(settingsService, ''));
});

test('getConfiguredProviderNames includes built-in and custom names', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  const names = getConfiguredProviderNames(settingsService);
  t.true(names.has('openai'));
  t.true(names.has('custom-ollama'));
});

test('loadProviderItems includes built-in providers without custom flag', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const items = loadProviderItems(settingsService);
  const openai = items.find((i) => i.id === 'openai');
  t.truthy(openai);
  t.false(openai!.isCustom);
  t.true(openai!.isActive);
});

test('loadProviderItems includes custom providers with custom flag', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  const items = loadProviderItems(settingsService);
  const custom = items.find((i) => i.id === 'custom-ollama');
  t.truthy(custom);
  t.true(custom!.isCustom);
  t.false(custom!.isActive);
});

test('loadProviderItems marks active provider correctly', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'custom-ollama',
  );
  const items = loadProviderItems(settingsService);
  const custom = items.find((i) => i.id === 'custom-ollama');
  t.true(custom!.isActive);
  const openai = items.find((i) => i.id === 'openai');
  t.false(openai!.isActive);
});

test('loadProviderItems ensures active provider is present even if not otherwise collected', (t) => {
  const settingsService = createMockSettingsService([], 'some-unknown-active');
  const items = loadProviderItems(settingsService);
  const active = items.find((i) => i.id === 'some-unknown-active');
  t.truthy(active);
  t.true(active!.isActive);
});

test('saveProvider validates empty name', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: '', type: 'openai-compatible' }, null);
  t.false(result.success);
  t.truthy(result.fieldErrors?.name);
});

test('saveProvider validates invalid name format', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'bad name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  t.false(result.success);
  t.truthy(result.fieldErrors?.name);
});

test('saveProvider validates name conflict', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'openai', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  t.false(result.success);
  t.truthy(result.fieldErrors?.name);
  t.true(result.fieldErrors!.name!.includes('already exists'));
});

test('saveProvider validates required base URL', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'my-provider', type: 'openai-compatible' }, null);
  t.false(result.success);
  t.truthy(result.fieldErrors?.baseUrl);
});

test('saveProvider succeeds with valid provider', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(
    settingsService,
    { name: 'my-provider', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    null,
  );
  t.true(result.success);
  const providers = settingsService.get('providers');
  t.true(Array.isArray(providers));
  t.is(providers.length, 1);
  t.is(providers[0].name, 'my-provider');
});

test('saveProvider succeeds without baseUrl for types that do not require it', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'my-anthropic', type: 'anthropic' }, null);
  t.true(result.success);
});

test('saveProvider edits an existing provider', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = saveProvider(
    settingsService,
    { name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:9090/v1' },
    'old-name',
  );
  t.true(result.success);
  const providers = settingsService.get('providers');
  t.is(providers.length, 1);
  t.is(providers[0].name, 'old-name');
  t.is(providers[0].baseUrl, 'http://localhost:9090/v1');
});

test('saveProvider renames an existing provider', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'old-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' }],
    'openai',
  );
  const result = saveProvider(
    settingsService,
    { name: 'new-name', type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    'old-name',
  );
  t.true(result.success);
  const providers = settingsService.get('providers');
  t.is(providers.length, 1);
  t.is(providers[0].name, 'new-name');
});

test('saveProvider saves API key for built-in provider', (t) => {
  const settingsService = createMockSettingsService([], 'openai');
  const result = saveProvider(settingsService, { name: 'OpenAI', type: 'openai', apiKey: 'sk-test-key' }, 'openai');
  t.true(result.success);
  t.is(settingsService.get('agent.openai.apiKey'), 'sk-test-key');
});

test('deleteCustomProvider removes provider from settings and registry', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'custom-ollama',
  );
  deleteCustomProvider(settingsService, 'custom-ollama');
  const providers = settingsService.get('providers');
  t.is(providers.length, 0);
  t.is(settingsService.get('agent.provider'), 'openai');
});

test('deleteCustomProvider does not change active provider when deleting inactive one', (t) => {
  const settingsService = createMockSettingsService(
    [{ name: 'custom-ollama', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
    'openai',
  );
  deleteCustomProvider(settingsService, 'custom-ollama');
  t.is(settingsService.get('agent.provider'), 'openai');
});
