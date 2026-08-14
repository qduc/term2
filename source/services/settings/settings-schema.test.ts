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

it('disables the model-request wall-clock deadline by default while allowing an explicit limit', () => {
  expect(AgentSettingsSchema.parse({}).maxModelRequestDurationMs).toBe(0);
  expect(AgentSettingsSchema.parse({ maxModelRequestDurationMs: 600_000 }).maxModelRequestDurationMs).toBe(600_000);
  expect(() => AgentSettingsSchema.parse({ maxModelRequestDurationMs: -1 })).toThrow();
});

it('Codex websocket receive timeouts default to transport-safe values and reject invalid values', () => {
  expect(AgentSettingsSchema.parse({}).codex).toEqual({
    websocketFirstFrameTimeoutMs: 90_000,
    websocketInterFrameTimeoutMs: 600_000,
  });

  expect(
    SettingsSchema.parse({
      agent: {
        codex: {
          websocketFirstFrameTimeoutMs: 45_000,
          websocketInterFrameTimeoutMs: 300_000,
        },
      },
    }).agent?.codex,
  ).toEqual({
    websocketFirstFrameTimeoutMs: 45_000,
    websocketInterFrameTimeoutMs: 300_000,
  });

  for (const value of [0, -1, 1.5, Infinity, Number.NaN]) {
    expect(() => SettingsSchema.parse({ agent: { codex: { websocketFirstFrameTimeoutMs: value } } })).toThrow();
    expect(() => SettingsSchema.parse({ agent: { codex: { websocketInterFrameTimeoutMs: value } } })).toThrow();
  }
});

it('context compaction defaults to disabled with a conservative ratio and rejects invalid ratios', () => {
  expect(AgentSettingsSchema.parse({}).contextCompaction).toEqual({
    enabled: false,
    mode: 'auto',
    compactThreshold: 0.8,
    compactThresholdTokens: null,
  });
  expect(DEFAULT_SETTINGS.agent.contextCompaction).toEqual({
    enabled: false,
    mode: 'auto',
    compactThreshold: 0.8,
    compactThresholdTokens: null,
  });
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_MODE)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS)).toBe(true);

  expect(
    SettingsSchema.parse({
      agent: {
        contextCompaction: {
          enabled: true,
          mode: 'auto',
          compactThreshold: 0.5,
          compactThresholdTokens: 40_000,
        },
      },
    }).agent?.contextCompaction,
  ).toEqual({ enabled: true, mode: 'auto', compactThreshold: 0.5, compactThresholdTokens: 40_000 });

  for (const compactThreshold of [-0.01, 1.01, Infinity, Number.NaN]) {
    expect(() => SettingsSchema.parse({ agent: { contextCompaction: { compactThreshold } } })).toThrow();
  }

  expect(
    SettingsSchema.parse({ agent: { contextCompaction: { compactThreshold: 0 } } }).agent?.contextCompaction,
  ).toMatchObject({ compactThreshold: 0 });
  expect(
    SettingsSchema.parse({ agent: { contextCompaction: { compactThreshold: 1 } } }).agent?.contextCompaction,
  ).toMatchObject({ compactThreshold: 1 });

  for (const mode of ['native', 'auto', 'local'] as const) {
    expect(SettingsSchema.parse({ agent: { contextCompaction: { mode } } }).agent?.contextCompaction.mode).toBe(mode);
  }
  expect(() => SettingsSchema.parse({ agent: { contextCompaction: { mode: 'unknown' } } })).toThrow();
  for (const compactThresholdTokens of [0, 999, 1.5, Infinity, Number.NaN]) {
    expect(() => SettingsSchema.parse({ agent: { contextCompaction: { compactThresholdTokens } } })).toThrow();
  }
});

it('memory settings default to enabled local storage with bounded retrieval and context budgets', () => {
  const parsed = SettingsSchema.parse({});
  expect(parsed.memory).toMatchObject({
    enabled: true,
    contextBudgetChars: 3000,
    searchDefaultLimit: 10,
    searchMaxLimit: 50,
  });
  expect(() => SettingsSchema.parse({ memory: { contextBudgetChars: 0 } })).toThrow();
  expect(() => SettingsSchema.parse({ memory: { searchDefaultLimit: 51, searchMaxLimit: 50 } })).toThrow();
});

it('SettingsSchema includes sandbox settings, which default to compatibility-first behavior', () => {
  const parsed = SettingsSchema.parse({ sandbox: {} });
  expect(parsed.sandbox?.enabled).toBe(true);
  expect(parsed.sandbox?.readPolicy).toBe('standard');
  expect(parsed.sandbox?.allowReadExtra).toEqual([]);
  expect(parsed.sandbox?.dockerHostControlProjects).toEqual([]);
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
  expect(DEFAULT_SETTINGS.sandbox.dockerHostControlProjects).toEqual([]);
  expect(DEFAULT_SETTINGS.sandbox.allowNetworking).toBe(false);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ENABLED)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_READ_POLICY)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ALLOW_READ_EXTRA)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_DOCKER_HOST_CONTROL_PROJECTS)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SANDBOX_ALLOW_NETWORKING)).toBe(true);
});

it('auto-approval reasoning effort defaults to low and is runtime modifiable', () => {
  expect(AgentSettingsSchema.parse({}).autoApproveReasoningEffort).toBe('low');
  expect(DEFAULT_SETTINGS.agent.autoApproveReasoningEffort).toBe('low');
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_AUTO_APPROVE_REASONING_EFFORT)).toBe(true);
  expect(() => AgentSettingsSchema.parse({ autoApproveReasoningEffort: 'default' })).toThrow();
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
    maxConsoleBytes: 16_384,
  });
  expect(
    SettingsSchema.parse({ agentWorkflow: { maxRuns: 2, maxOutputBytes: 1024, maxConsoleBytes: 512 } }).agentWorkflow,
  ).toMatchObject({
    maxRuns: 2,
    maxOutputBytes: 1024,
    maxConsoleBytes: 512,
  });
  expect(() => SettingsSchema.parse({ agentWorkflow: { maxConcurrency: 0 } })).toThrow();
  expect(() => SettingsSchema.parse({ agentWorkflow: { maxConsoleBytes: 0 } })).toThrow();
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

it('shell.backgroundTimeout defaults to 30 minutes, is runtime modifiable, and is bounded', () => {
  const parsed = SettingsSchema.parse({ shell: {} });
  expect(parsed.shell?.backgroundTimeout).toBe(30 * 60 * 1000);
  expect(DEFAULT_SETTINGS.shell.backgroundTimeout).toBe(30 * 60 * 1000);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.SHELL_BACKGROUND_TIMEOUT)).toBe(true);

  expect(SettingsSchema.parse({ shell: { backgroundTimeout: 60_000 } }).shell?.backgroundTimeout).toBe(60_000);

  // Capped: never zero, never negative, never unbounded.
  for (const value of [0, -1, 1.5, Infinity, Number.NaN]) {
    expect(() => SettingsSchema.parse({ shell: { backgroundTimeout: value } })).toThrow();
  }
});

it('SettingsSchema preserves user-configured workflow model tiers', () => {
  const parsed = SettingsSchema.parse({
    agent: { efficientModel: 'gpt-5-mini', capableModel: 'gpt-5.3-codex' },
  });

  expect(parsed.agent?.efficientModel).toBe('gpt-5-mini');
  expect(parsed.agent?.capableModel).toBe('gpt-5.3-codex');
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_EFFICIENT_MODEL)).toBe(true);
  expect(RUNTIME_MODIFIABLE_SETTINGS.has(SETTING_KEYS.AGENT_CAPABLE_MODEL)).toBe(true);
  expect(() => SettingsSchema.parse({ agent: { efficientModel: '' } })).toThrow();
  expect(() => SettingsSchema.parse({ agent: { capableModel: '' } })).toThrow();
});

it('SettingsSchema preserves optional flat ancillary model tiers and their providers', () => {
  const parsed = SettingsSchema.parse({
    agent: {
      smartModel: 'smart-model',
      smartProvider: 'smart-provider',
      balancedModel: 'balanced-model',
      balancedProvider: 'balanced-provider',
      cheapModel: 'cheap-model',
      cheapProvider: 'cheap-provider',
      choreModel: 'chore-model',
      choreProvider: 'chore-provider',
    },
  });

  expect(parsed.agent).toMatchObject({
    smartModel: 'smart-model',
    smartProvider: 'smart-provider',
    balancedModel: 'balanced-model',
    balancedProvider: 'balanced-provider',
    cheapModel: 'cheap-model',
    cheapProvider: 'cheap-provider',
    choreModel: 'chore-model',
    choreProvider: 'chore-provider',
  });
  const defaults = AgentSettingsSchema.parse({});
  for (const key of [
    'smartModel',
    'smartProvider',
    'balancedModel',
    'balancedProvider',
    'cheapModel',
    'cheapProvider',
    'choreModel',
    'choreProvider',
  ]) {
    expect(defaults[key as keyof typeof defaults]).toBeUndefined();
  }
  for (const key of [
    SETTING_KEYS.AGENT_SMART_MODEL,
    SETTING_KEYS.AGENT_SMART_PROVIDER,
    SETTING_KEYS.AGENT_BALANCED_MODEL,
    SETTING_KEYS.AGENT_BALANCED_PROVIDER,
    SETTING_KEYS.AGENT_CHEAP_MODEL,
    SETTING_KEYS.AGENT_CHEAP_PROVIDER,
    SETTING_KEYS.AGENT_CHORE_MODEL,
    SETTING_KEYS.AGENT_CHORE_PROVIDER,
  ]) {
    expect(RUNTIME_MODIFIABLE_SETTINGS.has(key)).toBe(true);
  }
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
