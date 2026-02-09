import type { SettingsData } from './settings-schema.js';

/**
 * Build environment-derived overrides from process.env
 * Used during CLI initialization.
 */
export function buildEnvOverrides(): Partial<SettingsData> {
  const env = (typeof process !== 'undefined' ? process.env : {}) as any;
  const openrouter: any = {};
  if (env.OPENROUTER_API_KEY) openrouter.apiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) openrouter.model = env.OPENROUTER_MODEL;
  if (env.OPENROUTER_BASE_URL) openrouter.baseUrl = env.OPENROUTER_BASE_URL;
  if (env.OPENROUTER_REFERRER) openrouter.referrer = env.OPENROUTER_REFERRER;
  if (env.OPENROUTER_TITLE) openrouter.title = env.OPENROUTER_TITLE;

  const logging: any = {};
  if (env.LOG_LEVEL) logging.logLevel = env.LOG_LEVEL;
  if (env.DISABLE_LOGGING !== undefined) logging.disableLogging = String(env.DISABLE_LOGGING) === 'true';
  if (env.DEBUG_LOGGING !== undefined) logging.debugLogging = true;

  const environment: any = {
    nodeEnv: env.NODE_ENV,
  };

  const app: any = {
    shellPath: env.SHELL || env.COMSPEC,
  };

  const tools: any = {};
  if (env.LOG_FILE_OPERATIONS !== undefined) tools.logFileOperations = String(env.LOG_FILE_OPERATIONS) !== 'false';

  const debug: any = {};
  if (env.DEBUG_BASH_TOOL !== undefined) debug.debugBashTool = true;

  const webSearch: any = {};
  if (env.TAVILY_API_KEY) {
    webSearch.tavily = { apiKey: env.TAVILY_API_KEY };
  }
  if (env.WEB_SEARCH_PROVIDER) {
    webSearch.provider = env.WEB_SEARCH_PROVIDER;
  }

  const agent: any = { openrouter };

  return {
    agent,
    logging,
    environment,
    app,
    tools,
    debug,
    webSearch,
  } as Partial<SettingsData>;
}

export const parseBooleanEnv = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

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
