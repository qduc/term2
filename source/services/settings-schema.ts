import { z } from 'zod';

// Import providers to ensure they're registered before schema construction
import '../providers/index.js';
import { getAllProviders } from '../providers/index.js';
import { getAllWebSearchProviders } from '../providers/web-search/index.js';

// Define schemas for validation
export const AgentSettingsSchema = z.object({
  model: z.string().min(1).default('gpt-5.1'),
  // 'default' signals we should *not* explicitly pass a reasoningEffort
  // to the API, allowing it to decide what to use.
  reasoningEffort: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high']).default('default'),
  // Temperature controls randomness. We keep it optional so providers/models
  // can use their own defaults when unset.
  temperature: z.number().min(0).max(2).optional(),
  maxTurns: z.number().int().positive().default(100),
  retryAttempts: z.number().int().nonnegative().default(2),
  // NOTE: We do NOT validate provider existence here because the provider
  // registry can be extended at runtime from settings.json (custom providers).
  // We validate/fallback after SettingsService loads and registers runtime providers.
  provider: z.string().min(1).default('openai').describe('Provider to use for the agent'),
  openrouter: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
      referrer: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  mentorModel: z.string().optional().describe('Model to use as a mentor'),
  mentorProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider to use for the mentor model (defaults to agent.provider when unset)'),
  mentorReasoningEffort: z
    .enum(['default', 'none', 'minimal', 'low', 'medium', 'high'])
    .default('default')
    .describe('Reasoning effort for the mentor model'),
  useFlexServiceTier: z
    .boolean()
    .optional()
    .default(false)
    .describe('Use OpenAI Flex Service Tier to reduce costs (OpenAI only)'),
});

export const ShellSettingsSchema = z.object({
  timeout: z.number().int().positive().default(120000),
  maxOutputLines: z.number().int().positive().default(1000),
  maxOutputChars: z.number().int().positive().default(10000),
});

export const UISettingsSchema = z.object({
  historySize: z.number().int().positive().default(1000),
});

export const LoggingSettingsSchema = z.object({
  logLevel: z.enum(['error', 'warn', 'info', 'security', 'debug']).default('info'),
  disableLogging: z.boolean().optional().default(false),
  debugLogging: z.boolean().optional().default(false),
  suppressConsoleOutput: z.boolean().optional().default(true),
});

export const EnvironmentSettingsSchema = z.object({
  nodeEnv: z.string().optional(),
});

export const AppSettingsSchema = z.object({
  shellPath: z.string().optional(),
  // Independent mode flags that can be enabled together and persist across sessions
  // mentorMode: uses simplified mentor prompt and enables ask_mentor tool (if mentorModel configured)
  // editMode: auto-approves apply_patch operations within cwd for faster file editing
  // liteMode: minimal context for general terminal assistance (no codebase tools/prompts)
  mentorMode: z.boolean().optional().default(false),
  editMode: z.boolean().optional().default(false),
  liteMode: z.boolean().optional().default(false),
});

export const ToolsSettingsSchema = z.object({
  logFileOperations: z.boolean().optional().default(true),
  enableEditHealing: z.boolean().optional().default(true),
  editHealingModel: z.string().optional().default('gpt-4o-mini'),
});

export const DebugSettingsSchema = z.object({
  debugBashTool: z.boolean().optional().default(false),
});

export const SSHSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().optional(),
  port: z.number().int().positive().default(22),
  username: z.string().optional(),
  remoteDir: z.string().optional(),
});

export const WebSearchSettingsSchema = z.object({
  provider: z.string().optional(),
  tavily: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
});

export const CustomProviderSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
});

/**
 * Settings that are sensitive and should NEVER be saved to disk.
 * These are only loaded from environment variables.
 */
export function getSensitiveSettingKeys(): Set<string> {
  const keys = new Set<string>(['app.shellPath']);

  // Add provider-specific sensitive keys
  for (const provider of getAllProviders()) {
    if (provider.sensitiveSettingKeys) {
      for (const key of provider.sensitiveSettingKeys) {
        keys.add(key);
      }
    }
  }

  // Add web search provider-specific sensitive keys
  for (const provider of getAllWebSearchProviders()) {
    if (provider.sensitiveSettingKeys) {
      for (const key of provider.sensitiveSettingKeys) {
        keys.add(key);
      }
    }
  }

  return keys;
}

export const SENSITIVE_SETTING_KEYS = getSensitiveSettingKeys();

export const SettingsSchema = z.object({
  providers: z.array(CustomProviderSchema).optional().default([]),
  agent: AgentSettingsSchema.optional(),
  shell: ShellSettingsSchema.optional(),
  ui: UISettingsSchema.optional(),
  logging: LoggingSettingsSchema.optional(),
  environment: EnvironmentSettingsSchema.optional(),
  app: AppSettingsSchema.optional(),
  tools: ToolsSettingsSchema.optional(),
  debug: DebugSettingsSchema.optional(),
  ssh: SSHSettingsSchema.optional(),
  webSearch: WebSearchSettingsSchema.optional(),
});

// Type definitions
export interface SettingsData {
  providers: Array<z.infer<typeof CustomProviderSchema>>;
  agent: z.infer<typeof AgentSettingsSchema>;
  shell: z.infer<typeof ShellSettingsSchema>;
  ui: z.infer<typeof UISettingsSchema>;
  logging: z.infer<typeof LoggingSettingsSchema>;
  environment: z.infer<typeof EnvironmentSettingsSchema>;
  app: z.infer<typeof AppSettingsSchema>;
  tools: z.infer<typeof ToolsSettingsSchema>;
  debug: z.infer<typeof DebugSettingsSchema>;
  ssh: z.infer<typeof SSHSettingsSchema>;
  webSearch: z.infer<typeof WebSearchSettingsSchema>;
}

export type SettingSource = 'cli' | 'env' | 'config' | 'default';

export interface SettingWithSource<T = any> {
  value: T;
  source: SettingSource;
}

export interface SettingsWithSources {
  agent: {
    model: SettingWithSource<string>;
    reasoningEffort: SettingWithSource<string>;
    temperature: SettingWithSource<number | undefined>;
    maxTurns: SettingWithSource<number>;
    retryAttempts: SettingWithSource<number>;
    provider: SettingWithSource<string>;
    openrouter: SettingWithSource<any>;
    mentorModel: SettingWithSource<string | undefined>;
    mentorProvider: SettingWithSource<string | undefined>;
    mentorReasoningEffort: SettingWithSource<string>;
    useFlexServiceTier: SettingWithSource<boolean>;
  };
  shell: {
    timeout: SettingWithSource<number>;
    maxOutputLines: SettingWithSource<number>;
    maxOutputChars: SettingWithSource<number>;
  };
  ui: {
    historySize: SettingWithSource<number>;
  };
  logging: {
    logLevel: SettingWithSource<string>;
    disableLogging: SettingWithSource<boolean>;
    debugLogging: SettingWithSource<boolean>;
    suppressConsoleOutput: SettingWithSource<boolean>;
  };
  environment: {
    nodeEnv: SettingWithSource<string | undefined>;
  };
  app: {
    shellPath: SettingWithSource<string | undefined>;
    mentorMode: SettingWithSource<boolean>;
    editMode: SettingWithSource<boolean>;
    liteMode: SettingWithSource<boolean>;
  };
  tools: {
    logFileOperations: SettingWithSource<boolean>;
    enableEditHealing: SettingWithSource<boolean>;
    editHealingModel: SettingWithSource<string>;
  };
  debug: {
    debugBashTool: SettingWithSource<boolean>;
  };
  ssh: {
    enabled: SettingWithSource<boolean>;
    host: SettingWithSource<string | undefined>;
    port: SettingWithSource<number>;
    username: SettingWithSource<string | undefined>;
    remoteDir: SettingWithSource<string | undefined>;
  };
  webSearch: {
    provider: SettingWithSource<string | undefined>;
    tavily: SettingWithSource<{ apiKey?: string } | undefined>;
  };
}

/**
 * Centralized list of all setting keys for consistency across the app.
 * Used by settings command UI and other components to avoid duplication.
 */
export const SETTING_KEYS = {
  AGENT_MODEL: 'agent.model',
  AGENT_REASONING_EFFORT: 'agent.reasoningEffort',
  AGENT_TEMPERATURE: 'agent.temperature',
  AGENT_PROVIDER: 'agent.provider',
  AGENT_MAX_TURNS: 'agent.maxTurns',
  AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
  AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey', // Sensitive - env only
  AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl', // Sensitive - env only
  AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer', // Sensitive - env only
  AGENT_OPENROUTER_TITLE: 'agent.openrouter.title', // Sensitive - env only
  AGENT_MENTOR_MODEL: 'agent.mentorModel',
  AGENT_MENTOR_PROVIDER: 'agent.mentorProvider',
  AGENT_MENTOR_REASONING_EFFORT: 'agent.mentorReasoningEffort',
  AGENT_USE_FLEX_SERVICE_TIER: 'agent.useFlexServiceTier',
  SHELL_TIMEOUT: 'shell.timeout',
  SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
  SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
  UI_HISTORY_SIZE: 'ui.historySize',
  LOGGING_LOG_LEVEL: 'logging.logLevel',
  LOGGING_DISABLE: 'logging.disableLogging',
  LOGGING_DEBUG: 'logging.debugLogging',
  LOGGING_SUPPRESS_CONSOLE: 'logging.suppressConsoleOutput',
  ENV_NODE_ENV: 'environment.nodeEnv',
  APP_SHELL_PATH: 'app.shellPath',
  APP_MENTOR_MODE: 'app.mentorMode',
  APP_EDIT_MODE: 'app.editMode',
  APP_LITE_MODE: 'app.liteMode',
  TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
  TOOLS_ENABLE_EDIT_HEALING: 'tools.enableEditHealing',
  TOOLS_EDIT_HEALING_MODEL: 'tools.editHealingModel',
  DEBUG_BASH_TOOL: 'debug.debugBashTool',
  SSH_ENABLED: 'ssh.enabled',
  SSH_HOST: 'ssh.host',
  SSH_PORT: 'ssh.port',
  SSH_USERNAME: 'ssh.username',
  SSH_REMOTE_DIR: 'ssh.remoteDir',
  WEB_SEARCH_PROVIDER: 'webSearch.provider',
  WEB_SEARCH_TAVILY_API_KEY: 'webSearch.tavily.apiKey',
} as const;

// Define which settings are modifiable at runtime
export const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>([
  SETTING_KEYS.AGENT_MODEL,
  SETTING_KEYS.AGENT_REASONING_EFFORT,
  SETTING_KEYS.AGENT_TEMPERATURE,
  SETTING_KEYS.AGENT_PROVIDER,
  SETTING_KEYS.AGENT_MENTOR_MODEL,
  SETTING_KEYS.AGENT_MENTOR_PROVIDER,
  SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT,
  SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER,
  SETTING_KEYS.SHELL_TIMEOUT,
  SETTING_KEYS.SHELL_MAX_OUTPUT_LINES,
  SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS,
  SETTING_KEYS.LOGGING_LOG_LEVEL,
  SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE,
  SETTING_KEYS.APP_MENTOR_MODE,
  SETTING_KEYS.APP_EDIT_MODE,
  SETTING_KEYS.APP_LITE_MODE,
]);

// Some settings with default values are optional to persist
export const OPTIONAL_DEFAULT_KEYS = new Set<string>([]);

// Default settings
export const DEFAULT_SETTINGS: SettingsData = {
  providers: [],
  agent: {
    model: 'gpt-5.1',
    reasoningEffort: 'default',
    maxTurns: 100,
    retryAttempts: 2,
    provider: 'openai',
    openrouter: {
      // defaults empty; can be provided via env or config
      // defaults empty; can be provided via env or config
    } as any,
    mentorModel: undefined,
    mentorProvider: undefined,
    mentorReasoningEffort: 'default',
    useFlexServiceTier: false,
  },
  shell: {
    timeout: 120000,
    maxOutputLines: 1000,
    maxOutputChars: 10000,
  },
  ui: {
    historySize: 1000,
  },
  logging: {
    logLevel: 'info',
    disableLogging: false,
    debugLogging: false,
    suppressConsoleOutput: true,
  },
  environment: {
    nodeEnv: undefined,
  },
  app: {
    shellPath: undefined,
    mentorMode: false,
    editMode: false,
    liteMode: false,
  },
  tools: {
    logFileOperations: true,
    enableEditHealing: true,
    editHealingModel: 'gpt-4o-mini',
  },
  debug: {
    debugBashTool: false,
  },
  ssh: {
    enabled: false,
    port: 22,
  },
  webSearch: {
    provider: 'tavily',
    tavily: {},
  },
};

/**
 * Publicly exported list of sensitive settings for UI/CLI components to use.
 * These settings should only be configured via environment variables.
 */
export const SENSITIVE_SETTINGS = {
  AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
  AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl',
  AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer',
  AGENT_OPENROUTER_TITLE: 'agent.openrouter.title',
  APP_SHELL_PATH: 'app.shellPath',
} as const;
