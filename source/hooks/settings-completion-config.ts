import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { getAllSettingDescriptions } from '../services/settings/settings-ui-metadata.js';

export type SettingCompletionItem = {
  key: string;
  /** Short human-readable name shown in the settings list. */
  label: string;
  description?: string;
  currentValue?: unknown;
  /** Where the current value comes from. `session` is an unsaved in-app change. */
  source?: 'cli' | 'env' | 'config' | 'session' | 'default';
  /** True when the current value differs from the built-in default. */
  isModified?: boolean;
  /** Environment variable or CLI flag that wins over the saved value at startup. */
  startupOverride?: { source: 'env' | 'cli'; name?: string };
  /** True when a change only takes effect after restarting term2. */
  requiresRestart?: boolean;
  /** Tuning knob kept out of the browse tabs; reachable through search. */
  isAdvanced?: boolean;
};

export type SettingsCategory = {
  id: string;
  label: string;
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'models', label: 'Models' },
  { id: 'providers', label: 'Providers' },
  { id: 'context', label: 'Context' },
  { id: 'safety', label: 'Safety' },
  { id: 'tools', label: 'Tools' },
  { id: 'ui', label: 'UI' },
  { id: 'hooks', label: 'Hooks' },
];

export const SETTING_DESCRIPTIONS: Record<string, string> = getAllSettingDescriptions();

/**
 * Settings that never appear in the menu, not even in search: legacy flags,
 * process plumbing, and values owned by another command (`/profile`).
 */
export const HIDDEN_SETTINGS = new Set<string>([
  SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT,
  SETTING_KEYS.LOGGING_DEBUG,
  SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE,
  SETTING_KEYS.ENV_NODE_ENV,
  SETTING_KEYS.APP_SHELL_PATH,
  SETTING_KEYS.APP_ACTIVE_PROFILE_ID,
  SETTING_KEYS.APP_MENTOR_MODE,
  SETTING_KEYS.APP_LITE_MODE,
  SETTING_KEYS.APP_PLAN_MODE,
  SETTING_KEYS.APP_ORCHESTRATOR_MODE,
  SETTING_KEYS.TOOLS_LOG_FILE_OPS,
  SETTING_KEYS.DEBUG_BASH_TOOL,
  SETTING_KEYS.SSH_ENABLED,
  SETTING_KEYS.SSH_HOST,
  SETTING_KEYS.SSH_PORT,
  SETTING_KEYS.SSH_USERNAME,
  SETTING_KEYS.SSH_REMOTE_DIR,
  SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_REASONING_EFFORT,
  SETTING_KEYS.AGENT_SUBAGENT_WORKER_REASONING_EFFORT,
  SETTING_KEYS.AGENT_SUBAGENT_LIBRARIAN_REASONING_EFFORT,
  SETTING_KEYS.SANDBOX_ALLOW_READ_EXTRA,
]);

/**
 * The browse tabs: each lists the settings a user changes on purpose, in the
 * order they should read (most used first, related settings adjacent).
 *
 * Any visible setting not listed here is *advanced*: it stays out of the tabs
 * but is still found by search. That is the default for a new setting, so a
 * tuning knob never lands in a tab by accident.
 */
export const CATEGORY_KEYS: Record<string, readonly string[]> = {
  models: [
    SETTING_KEYS.AGENT_MODEL_SELECTION,
    SETTING_KEYS.AGENT_REASONING_EFFORT,
    SETTING_KEYS.AGENT_TEMPERATURE,
    SETTING_KEYS.AGENT_FAVORITE_MODELS,
    SETTING_KEYS.AGENT_MODEL_NICKNAMES,
    SETTING_KEYS.AGENT_SMART_MODEL,
    SETTING_KEYS.AGENT_SMART_REASONING_EFFORT,
    SETTING_KEYS.AGENT_BALANCED_MODEL,
    SETTING_KEYS.AGENT_BALANCED_REASONING_EFFORT,
    SETTING_KEYS.AGENT_CHEAP_MODEL,
    SETTING_KEYS.AGENT_CHEAP_REASONING_EFFORT,
    SETTING_KEYS.AGENT_CHORE_MODEL,
    SETTING_KEYS.AGENT_MENTOR_POOL,
    SETTING_KEYS.AGENT_DISABLED_PROVIDERS,
    SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER,
  ],
  providers: [
    SETTING_KEYS.AGENT_OPENROUTER_API_KEY,
    SETTING_KEYS.AGENT_OPENAI_API_KEY,
    SETTING_KEYS.WEB_SEARCH_PROVIDER,
    SETTING_KEYS.WEB_SEARCH_TAVILY_API_KEY,
    SETTING_KEYS.WEB_SEARCH_EXA_API_KEY,
    SETTING_KEYS.WEB_SEARCH_FIRECRAWL_API_KEY,
    SETTING_KEYS.WEB_SEARCH_SEARXNG_BASE_URL,
  ],
  context: [
    SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED,
    SETTING_KEYS.AGENT_CONTEXT_COMPACTION_MODE,
    SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD,
    SETTING_KEYS.AGENT_SESSION_ROLLOVER_ENABLED,
    SETTING_KEYS.AGENT_SESSION_ROLLOVER_AUTO_BRIEF,
    SETTING_KEYS.MEMORY_ENABLED,
    SETTING_KEYS.MEMORY_DIRECTORY,
  ],
  safety: [
    SETTING_KEYS.SHELL_AUTO_APPROVE_MODE,
    SETTING_KEYS.SANDBOX_ENABLED,
    SETTING_KEYS.SANDBOX_READ_POLICY,
    SETTING_KEYS.SANDBOX_ALLOW_NETWORKING,
    SETTING_KEYS.SANDBOX_DOCKER_HOST_CONTROL_PROJECTS,
    SETTING_KEYS.AGENT_COMPLETION_VERIFICATION,
    SETTING_KEYS.AGENT_RUN_BUDGET_MAX_USD_MICROS,
    SETTING_KEYS.AGENT_RUN_BUDGET_MAX_ACTIVE_TIME_MS,
    SETTING_KEYS.AGENT_RUN_BUDGET_MAX_UNPRICED_TOKENS,
    SETTING_KEYS.AGENT_RUN_BUDGET_ESCALATION,
    SETTING_KEYS.AGENT_MAX_TURNS,
  ],
  tools: [
    SETTING_KEYS.TOOLS_SHELL_ENABLED,
    SETTING_KEYS.TOOLS_FILE_READ_ENABLED,
    SETTING_KEYS.TOOLS_FILE_WRITE_ENABLED,
    SETTING_KEYS.TOOLS_WEB_ENABLED,
    SETTING_KEYS.TOOLS_MEMORY_ENABLED,
    SETTING_KEYS.TOOLS_SESSIONS_ENABLED,
    SETTING_KEYS.TOOLS_SKILLS_ENABLED,
    SETTING_KEYS.TOOLS_SUBAGENTS_ENABLED,
    SETTING_KEYS.TOOLS_BACKGROUND_TASKS_ENABLED,
    SETTING_KEYS.TOOLS_MENTOR_ENABLED,
    SETTING_KEYS.TOOLS_USER_INTERACTION_ENABLED,
    SETTING_KEYS.TOOLS_CODE_CONTEXT_ENABLED,
    SETTING_KEYS.ENABLE_AGENT_WORKFLOW,
    SETTING_KEYS.SHELL_TIMEOUT,
    SETTING_KEYS.AGENT_BACKGROUND_CHECK_IN_ENABLED,
    SETTING_KEYS.AGENT_BACKGROUND_CHECK_IN_INTERVAL_MS,
  ],
  ui: [
    SETTING_KEYS.UI_THEME,
    SETTING_KEYS.UI_SKIN,
    SETTING_KEYS.UI_DISPLAY_MODE,
    SETTING_KEYS.APP_NOTIFICATIONS,
    SETTING_KEYS.APP_NOTIFICATIONS_ON_APPROVAL,
    SETTING_KEYS.APP_NOTIFICATIONS_ON_COMPLETE,
  ],
  hooks: [
    SETTING_KEYS.HOOKS_USER_ENABLED,
    SETTING_KEYS.HOOKS_PROJECT_ENABLED,
    SETTING_KEYS.HOOKS_TRUSTED_PROJECT_ROOTS,
    SETTING_KEYS.HOOKS_INCLUDE_USER_TEXT,
    SETTING_KEYS.HOOKS_INCLUDE_TOOL_ARGUMENTS,
    SETTING_KEYS.HOOKS_INCLUDE_TOOL_RESULTS,
  ],
};

/**
 * Words people search with that appear in neither the label nor the
 * description ("cost" for the USD budget). Matched like label words.
 */
export const SETTING_SEARCH_KEYWORDS: Record<string, string> = {
  [SETTING_KEYS.AGENT_MODEL_SELECTION]: 'llm main default',
  [SETTING_KEYS.AGENT_REASONING_EFFORT]: 'thinking',
  [SETTING_KEYS.AGENT_RUN_BUDGET_MAX_USD_MICROS]: 'cost spend money price dollars limit cap',
  [SETTING_KEYS.AGENT_RUN_BUDGET_MAX_ACTIVE_TIME_MS]: 'limit cap duration',
  [SETTING_KEYS.AGENT_RUN_BUDGET_MAX_UNPRICED_TOKENS]: 'limit cap',
  [SETTING_KEYS.AGENT_RUN_BUDGET_ESCALATION]: 'budget exhausted pause warn',
  [SETTING_KEYS.AGENT_MAX_TURNS]: 'limit cap loop',
  [SETTING_KEYS.SANDBOX_ALLOW_NETWORKING]: 'internet network',
  [SETTING_KEYS.SHELL_AUTO_APPROVE_MODE]: 'permissions approval prompts yolo',
  [SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED]: 'summarize summary context window',
  [SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD]: 'summarize context window',
  [SETTING_KEYS.UI_THEME]: 'colors colours dark light',
  [SETTING_KEYS.UI_SKIN]: 'layout look style',
  [SETTING_KEYS.APP_NOTIFICATIONS]: 'alert bell desktop',
  [SETTING_KEYS.LOGGING_LOG_LEVEL]: 'logging debug verbose',
  [SETTING_KEYS.AGENT_OPENROUTER_API_KEY]: 'credentials token secret',
  [SETTING_KEYS.AGENT_OPENAI_API_KEY]: 'credentials token secret',
  [SETTING_KEYS.WEB_SEARCH_PROVIDER]: 'internet browse',
};
