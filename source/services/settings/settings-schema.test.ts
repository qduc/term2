import { it, expect } from 'vitest';
import {
  AgentSettingsSchema,
  CustomProviderSchema,
  DEFAULT_SETTINGS,
  KNOWN_CUSTOM_PROVIDER_TYPES,
  isKnownCustomProviderType,
  SettingsSchema,
  RUNTIME_MODIFIABLE_SETTINGS,
  SETTING_KEYS,
  normalizeAppModes,
} from './settings-schema.js';

it('SettingsSchema includes sandbox settings, which default to compatibility-first behavior', () => {
  const parsed = SettingsSchema.parse({ sandbox: {} });
  expect(parsed.sandbox?.enabled).toBe(true);
  expect(parsed.sandbox?.readPolicy).toBe('standard');
  expect(parsed.sandbox?.allowReadExtra).toEqual([]);
  expect(parsed.sandbox?.allowNetworking).toBe(false);

  const parsedDisabled = SettingsSchema.parse({ sandbox: { enabled: false } });
  expect(parsedDisabled.sandbox?.enabled).toBe(false);

  const parsedHomeDenylist = SettingsSchema.parse({
    sandbox: { readPolicy: 'strict', allowReadExtra: ['/tmp/cache'] },
  });
  expect(parsedHomeDenylist.sandbox?.readPolicy).toBe('strict');
  expect(parsedHomeDenylist.sandbox?.allowReadExtra).toEqual(['/tmp/cache']);

  const parsedNetworking = SettingsSchema.parse({ sandbox: { allowNetworking: true } });
  expect(parsedNetworking.sandbox?.allowNetworking).toBe(true);

  expect(() => SettingsSchema.parse({ sandbox: { readPolicy: 'deny-root' } })).toThrow();

  expect(DEFAULT_SETTINGS.sandbox.enabled).toBe(true);
  expect(DEFAULT_SETTINGS.sandbox.readPolicy).toBe('standard');
  expect(DEFAULT_SETTINGS.sandbox.allowReadExtra).toEqual([]);
  expect(DEFAULT_SETTINGS.sandbox.allowNetworking).toBe(false);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ENABLED)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_READ_POLICY)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ALLOW_READ_EXTRA)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ALLOW_NETWORKING)).toBe(true);
});

it('agent transport defaults to websocket and is runtime modifiable', () => {
  expect(DEFAULT_SETTINGS.agent.transport).toBe('websocket');
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_TRANSPORT)).toBe(true);
  expect(AgentSettingsSchema.parse({}).transport).toBe('websocket');

  expect(() => AgentSettingsSchema.parse({ transport: 'fallback' })).toThrow();
});

it('workflow limits have bounded defaults and accept workspace configuration', () => {
  const defaults = SettingsSchema.parse({});
  expect(defaults.agentWorkflow).toEqual({
    timeoutMs: 120_000,
    maxRuns: 8,
    maxConcurrency: 3,
    maxCodeBytes: 16_384,
    maxOutputBytes: 65_536,
  });
  expect(SettingsSchema.parse({ agentWorkflow: { maxRuns: 2, maxOutputBytes: 1024 } }).agentWorkflow).toMatchObject({
    maxRuns: 2,
    maxOutputBytes: 1024,
  });
  expect(() => SettingsSchema.parse({ agentWorkflow: { maxConcurrency: 0 } })).toThrow();
});

it('CustomProviderSchema defaults provider type for legacy configs', () => {
  const parsed = CustomProviderSchema.parse({
    name: 'local',
    baseUrl: 'http://localhost:11434/v1',
  });

  expect(parsed.type).toBe('openai-compatible');
});

it('CustomProviderSchema accepts known provider types', () => {
  for (const providerType of KNOWN_CUSTOM_PROVIDER_TYPES) {
    const parsed = CustomProviderSchema.parse({
      name: `provider-${providerType}`,
      type: providerType,
      baseUrl: 'http://localhost:11434/v1',
    });

    expect(parsed.type).toBe(providerType);
    expect(isKnownCustomProviderType(providerType)).toBe(true);
  }
});

it('CustomProviderSchema accepts llama.cpp as an OpenAI-compatible provider variant', () => {
  const parsed = CustomProviderSchema.parse({
    name: 'local',
    type: 'llama.cpp',
    baseUrl: 'http://localhost:11434/v1',
  });

  expect(parsed.type).toBe('llama.cpp');
  expect(isKnownCustomProviderType('llama.cpp')).toBe(true);
});

it('CustomProviderSchema rejects provider types outside the known list', () => {
  expect(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'unknown-provider',
      baseUrl: 'http://localhost:11434/v1',
    }),
  ).toThrow();
  expect(isKnownCustomProviderType('unknown-provider')).toBe(false);
});

it('CustomProviderSchema rejects invalid provider type format', () => {
  expect(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'bad type!',
      baseUrl: 'http://localhost:11434/v1',
    }),
  ).toThrow();
});

it('CustomProviderSchema allows anthropic type without baseUrl', () => {
  const parsed = CustomProviderSchema.parse({
    name: 'my-anthropic',
    type: 'anthropic',
  });

  expect(parsed.type).toBe('anthropic');
  expect(parsed.baseUrl).toBe(undefined);
});

it('CustomProviderSchema allows google type without baseUrl', () => {
  const parsed = CustomProviderSchema.parse({
    name: 'my-google',
    type: 'google',
  });

  expect(parsed.type).toBe('google');
  expect(parsed.baseUrl).toBe(undefined);
});

it('CustomProviderSchema rejects openai-compatible type without baseUrl', () => {
  expect(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'openai-compatible',
    }),
  ).toThrow();
});

it('CustomProviderSchema rejects openai type without baseUrl', () => {
  expect(() =>
    CustomProviderSchema.parse({
      name: 'local',
      type: 'openai',
    }),
  ).toThrow();
});

it('SettingsSchema includes app.planMode, which defaults to false and is modifiable at runtime', () => {
  const parsed = SettingsSchema.parse({ app: {} });
  expect(parsed.app?.planMode).toBe(false);

  const parsedTrue = SettingsSchema.parse({ app: { planMode: true } });
  expect(parsedTrue.app?.planMode).toBe(true);

  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.APP_PLAN_MODE)).toBe(true);
});

it('SettingsSchema includes app.orchestratorMode, which defaults to false and is modifiable at runtime', () => {
  const parsed = SettingsSchema.parse({ app: {} });
  expect(parsed.app?.orchestratorMode).toBe(false);

  const parsedTrue = SettingsSchema.parse({ app: { orchestratorMode: true } });
  expect(parsedTrue.app?.orchestratorMode).toBe(true);

  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.APP_ORCHESTRATOR_MODE)).toBe(true);
});

it('SettingsSchema includes agent.maxParallelToolCalls, which defaults to 3 and is modifiable at runtime', () => {
  const parsed = SettingsSchema.parse({ agent: {} });
  expect(parsed.agent?.maxParallelToolCalls).toBe(3);

  const parsedValue = SettingsSchema.parse({ agent: { maxParallelToolCalls: 6 } });
  expect(parsedValue.agent?.maxParallelToolCalls).toBe(6);

  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS)).toBe(true);
});

it('SettingsSchema rejects non-positive agent.maxParallelToolCalls values', () => {
  expect(() => SettingsSchema.parse({ agent: { maxParallelToolCalls: 0 } })).toThrow();
});

it('startup normalization: persisted orchestratorMode=true with implicit lite (positional prompt) does not produce liteMode=true', () => {
  // Simulate the cli.tsx startup logic:
  // - persisted/resumed settings have orchestratorMode: true
  // - a positional prompt is provided (hasPositionalPrompt=true, autoApprove=false)
  //   which would naively set liteMode=true via the implicit default
  // The normalizer must resolve this so orchestratorMode wins and liteMode stays false.
  //
  // Precedence: orchestratorMode > liteMode > planMode > mentorMode (first one wins).

  // persisted orchestratorMode + implicit liteMode both true → orchestrator wins
  const result = normalizeAppModes({
    orchestratorMode: true,
    liteMode: true, // implicit from positional prompt
    planMode: false,
    mentorMode: false,
  });

  expect(result.orchestratorMode).toBe(true);
  expect(result.liteMode).toBe(false);
  expect(result.planMode).toBe(false);
  expect(result.mentorMode).toBe(false);
});
