/**
 * Build environment-derived overrides from process.env
 * Used during CLI initialization.
 */
export function buildEnvOverrides() {
    const env = typeof process !== 'undefined' ? process.env : {};
    const openrouter = {};
    if (env.OPENROUTER_API_KEY)
        openrouter.apiKey = env.OPENROUTER_API_KEY;
    if (env.OPENROUTER_BASE_URL)
        openrouter.baseUrl = env.OPENROUTER_BASE_URL;
    if (env.OPENROUTER_REFERRER)
        openrouter.referrer = env.OPENROUTER_REFERRER;
    if (env.OPENROUTER_TITLE)
        openrouter.title = env.OPENROUTER_TITLE;
    const logging = {};
    if (env.LOG_LEVEL)
        logging.logLevel = env.LOG_LEVEL;
    if (env.DISABLE_LOGGING !== undefined)
        logging.disableLogging = String(env.DISABLE_LOGGING) === 'true';
    if (env.DEBUG_LOGGING !== undefined)
        logging.debugLogging = true;
    const environment = {
        nodeEnv: env.NODE_ENV,
    };
    const app = {
        shellPath: env.SHELL || env.COMSPEC,
    };
    const tools = {};
    if (env.LOG_FILE_OPERATIONS !== undefined)
        tools.logFileOperations = String(env.LOG_FILE_OPERATIONS) !== 'false';
    const debug = {};
    if (env.DEBUG_BASH_TOOL !== undefined)
        debug.debugBashTool = true;
    const webSearch = {};
    if (env.TAVILY_API_KEY) {
        webSearch.tavily = { apiKey: env.TAVILY_API_KEY };
    }
    if (env.EXA_API_KEY) {
        webSearch.exa = { apiKey: env.EXA_API_KEY };
    }
    if (env.FIRECRAWL_API_KEY || env.FIRECRAWL_BASE_URL) {
        webSearch.firecrawl = {};
        if (env.FIRECRAWL_API_KEY)
            webSearch.firecrawl.apiKey = env.FIRECRAWL_API_KEY;
        if (env.FIRECRAWL_BASE_URL)
            webSearch.firecrawl.baseUrl = env.FIRECRAWL_BASE_URL;
    }
    if (env.SEARXNG_BASE_URL)
        webSearch.searxng = { baseUrl: env.SEARXNG_BASE_URL };
    if (env.WEB_SEARCH_PROVIDER) {
        webSearch.provider = env.WEB_SEARCH_PROVIDER;
    }
    const openai = {};
    if (env.OPENAI_API_KEY)
        openai.apiKey = env.OPENAI_API_KEY;
    const agent = { openrouter, openai };
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
    };
}
/**
 * Environment variable behind each env-mapped setting, for messages that tell
 * the user what overrides a saved value. Keep in step with buildEnvOverrides.
 */
export const SETTING_ENV_VARIABLES = {
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
export const parseBooleanEnv = (value) => {
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
export const isTestEnvironment = () => {
    return (process.env.NODE_ENV === 'test' ||
        process.env.VITEST !== undefined ||
        process.env.AVA_PATH !== undefined ||
        process.env.JEST_WORKER_ID !== undefined ||
        process.env.TERM2_TEST_MODE === 'true');
};
//# sourceMappingURL=settings-env.js.map