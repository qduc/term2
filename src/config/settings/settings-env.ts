import { SettingsSchema, type SettingsData } from './settings-schema.js';

export type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Array<infer U>
  ? Array<U>
  : T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

/**
 * Build environment-derived overrides from process.env
 * Used during CLI initialization.
 */
export function buildEnvOverrides(): Partial<SettingsData> {
  const env = typeof process !== 'undefined' ? process.env : {};
  const openrouter: DeepPartial<NonNullable<SettingsData['agent']['openrouter']>> = {};
  if (env.OPENROUTER_API_KEY) openrouter.apiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_BASE_URL) openrouter.baseUrl = env.OPENROUTER_BASE_URL;
  if (env.OPENROUTER_REFERRER) openrouter.referrer = env.OPENROUTER_REFERRER;
  if (env.OPENROUTER_TITLE) openrouter.title = env.OPENROUTER_TITLE;

  const logging: DeepPartial<SettingsData['logging']> = {};
  if (env.LOG_LEVEL) logging.logLevel = env.LOG_LEVEL as SettingsData['logging']['logLevel'];
  if (env.DISABLE_LOGGING !== undefined) logging.disableLogging = booleanEnvOr(env.DISABLE_LOGGING, false);
  if (env.DEBUG_LOGGING !== undefined) logging.debugLogging = booleanEnvOr(env.DEBUG_LOGGING, true);

  const environment: DeepPartial<SettingsData['environment']> = {
    nodeEnv: env.NODE_ENV,
  };

  const app: DeepPartial<SettingsData['app']> = {
    shellPath: env.SHELL || env.COMSPEC,
  };

  const tools: DeepPartial<SettingsData['tools']> = {};
  if (env.LOG_FILE_OPERATIONS !== undefined) tools.logFileOperations = booleanEnvOr(env.LOG_FILE_OPERATIONS, true);

  // createRestartPlan emits these policy values as env overrides. Consume them
  // before settings layering so a restart cannot restore conflicting saved policy.
  const shell: DeepPartial<SettingsData['shell']> = {};
  if (env.SHELL_AUTO_APPROVE_MODE !== undefined) {
    const parsed = SettingsSchema.shape.shell.unwrap().shape.autoApproveMode.safeParse(env.SHELL_AUTO_APPROVE_MODE);
    if (!parsed.success) {
      throw new Error(`Invalid SHELL_AUTO_APPROVE_MODE: ${parsed.error.issues[0]?.message}`);
    }
    shell.autoApproveMode = parsed.data;
  }
  if (env.TERM2_SHOW_REVIEW !== undefined)
    shell.showReview = parseStrictBooleanEnv('TERM2_SHOW_REVIEW', env.TERM2_SHOW_REVIEW);
  const sandbox: DeepPartial<SettingsData['sandbox']> = {};
  if (env.SANDBOX_ENABLED !== undefined)
    sandbox.enabled = parseStrictBooleanEnv('SANDBOX_ENABLED', env.SANDBOX_ENABLED);

  const debug: DeepPartial<SettingsData['debug']> = {};
  if (env.DEBUG_BASH_TOOL !== undefined) debug.debugBashTool = booleanEnvOr(env.DEBUG_BASH_TOOL, true);

  const webSearch: DeepPartial<SettingsData['webSearch']> = {};
  if (env.TAVILY_API_KEY) {
    webSearch.tavily = { apiKey: env.TAVILY_API_KEY };
  }
  if (env.EXA_API_KEY) {
    webSearch.exa = { apiKey: env.EXA_API_KEY };
  }
  if (env.FIRECRAWL_API_KEY || env.FIRECRAWL_BASE_URL) {
    webSearch.firecrawl = {};
    if (env.FIRECRAWL_API_KEY) webSearch.firecrawl.apiKey = env.FIRECRAWL_API_KEY;
    if (env.FIRECRAWL_BASE_URL) webSearch.firecrawl.baseUrl = env.FIRECRAWL_BASE_URL;
  }
  if (env.SEARXNG_BASE_URL) webSearch.searxng = { baseUrl: env.SEARXNG_BASE_URL };
  if (env.WEB_SEARCH_PROVIDER) {
    webSearch.provider = env.WEB_SEARCH_PROVIDER;
  }

  const openai: DeepPartial<NonNullable<SettingsData['agent']['openai']>> = {};
  if (env.OPENAI_API_KEY) openai.apiKey = env.OPENAI_API_KEY;

  const agent: DeepPartial<SettingsData['agent']> = { openrouter, openai };
  // Explicit unattended profile; leaves interactive and persisted defaults intact.
  if (env.TERM2_SUPERVISED === '1') {
    agent.maxRequestInputTokens = 80_000;
    agent.maxOutputTokens = 8_192;
    agent.contextCompaction = { enabled: true, mode: 'local', compactThreshold: 0.8, compactThresholdTokens: 60_000 };
  }

  return {
    agent,
    logging,
    environment,
    app,
    tools,
    debug,
    webSearch,
    shell,
    sandbox,
  } as Partial<SettingsData>;
}

/**
 * Credentials whose environment variable is a fallback, not an override: a
 * non-empty key saved in settings.json wins (owner decision 2026-11-22), the
 * same order custom providers already use for their stored key. Every other
 * env-mapped setting keeps env > settings.json.
 */
export const ENV_FALLBACK_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'agent.openrouter.apiKey',
  'agent.openai.apiKey',
  'webSearch.tavily.apiKey',
  'webSearch.exa.apiKey',
  'webSearch.firecrawl.apiKey',
]);

/**
 * The env layer with every fallback credential removed that `config` already
 * supplies as a non-empty string. Returns `env` itself when nothing is removed.
 */
export function withoutSavedCredentials<T extends object>(env: T, config: unknown): T {
  let result: T | undefined;
  for (const key of ENV_FALLBACK_CREDENTIAL_KEYS) {
    const saved = readPath(config, key);
    if (typeof saved !== 'string' || saved.trim().length === 0) continue;
    if (readPath(result ?? env, key) === undefined) continue;
    result ??= structuredClone(env);
    const parts = key.split('.');
    const parent = readPath(result, parts.slice(0, -1).join('.')) as Record<string, unknown>;
    delete parent[parts[parts.length - 1]!];
  }
  return result ?? env;
}

function readPath(source: unknown, key: string): unknown {
  let value = source;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Environment variable behind each env-mapped setting, for messages that tell
 * the user what overrides a saved value. Keep in step with buildEnvOverrides.
 */
export const SETTING_ENV_VARIABLES: Record<string, string> = {
  'shell.showReview': 'TERM2_SHOW_REVIEW',
  'shell.autoApproveMode': 'SHELL_AUTO_APPROVE_MODE',
  'sandbox.enabled': 'SANDBOX_ENABLED',
  'agent.openrouter.apiKey': 'OPENROUTER_API_KEY',
  'agent.openrouter.baseUrl': 'OPENROUTER_BASE_URL',
  'agent.openrouter.referrer': 'OPENROUTER_REFERRER',
  'agent.openrouter.title': 'OPENROUTER_TITLE',
  'agent.openai.apiKey': 'OPENAI_API_KEY',
  'logging.logLevel': 'LOG_LEVEL',
  'logging.disableLogging': 'DISABLE_LOGGING',
  'logging.debugLogging': 'DEBUG_LOGGING',
  'tools.logFileOperations': 'LOG_FILE_OPERATIONS',
  'debug.debugBashTool': 'DEBUG_BASH_TOOL',
  'webSearch.tavily.apiKey': 'TAVILY_API_KEY',
  'webSearch.exa.apiKey': 'EXA_API_KEY',
  'webSearch.firecrawl.apiKey': 'FIRECRAWL_API_KEY',
  'webSearch.firecrawl.baseUrl': 'FIRECRAWL_BASE_URL',
  'webSearch.searxng.baseUrl': 'SEARXNG_BASE_URL',
  'webSearch.provider': 'WEB_SEARCH_PROVIDER',
};

function parseStrictBooleanEnv(name: string, value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  }
  throw new Error(`Invalid ${name}: expected true, false, 1, 0, yes, or no`);
}

export const parseBooleanEnv = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

/**
 * A lenient boolean env override: the true spellings of `parseBooleanEnv` are true, `0`/`false`/`no` are false, and
 * any other value gives `unrecognised` (what each variable did before it shared this rule).
 */
function booleanEnvOr(value: unknown, unrecognised: boolean): boolean {
  if (parseBooleanEnv(value)) return true;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['0', 'false', 'no'].includes(normalized) ? false : unrecognised;
}

// Detect if running in test environment.
//
// We intentionally use a broad set of signals because different test runners
// set different environment variables. This prevents unit/integration tests
// from writing to disk by default (which can cause flaky tests and polluted
// developer machines/CI workspaces).
export const isTestEnvironment = (): boolean => {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST !== undefined ||
    process.env.AVA_PATH !== undefined ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.TERM2_TEST_MODE === 'true'
  );
};
