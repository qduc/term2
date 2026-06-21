import { z } from 'zod';

// Define schemas for validation
export const AgentSettingsSchema = z.object({
  model: z.string().min(1).default('gpt-5.1'),
  // 'default' signals we should *not* explicitly pass a reasoningEffort
  // to the API, allowing it to decide what to use.
  reasoningEffort: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('default'),
  // Temperature controls randomness. We keep it optional so providers/models
  // can use their own defaults when unset.
  temperature: z.number().min(0).max(2).optional(),
  maxTurns: z.number().int().positive().default(100),
  retryAttempts: z.number().int().nonnegative().default(2),
  transport: z.enum(['websocket', 'http']).default('websocket'),
  maxParallelToolCalls: z
    .number()
    .int()
    .positive()
    .default(3)
    .describe('Maximum number of tool calls allowed to run at the same time'),
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
  openai: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  mentorModel: z.string().optional().describe('Model to use as a mentor'),
  mentorProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider to use for the mentor model (defaults to agent.provider when unset)'),
  mentorReasoningEffort: z
    .enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .default('default')
    .describe('Reasoning effort for the mentor model'),
  useFlexServiceTier: z
    .boolean()
    .optional()
    .default(false)
    .describe('Use OpenAI Flex Service Tier to reduce costs (OpenAI only)'),
  autoApproveModel: z
    .string()
    .optional()
    .default('gpt-4o-mini')
    .describe('Faster model to use for auto-approval evaluation'),
  autoApproveProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider to use for the auto-approval model (defaults to agent.provider when unset)'),
  subagentExplorerModel: z
    .string()
    .min(1)
    .optional()
    .describe('Model override for the explorer subagent. Falls back to agent.model when unset.'),
  subagentExplorerProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider override for the explorer subagent. Falls back to agent.provider when unset.'),
  subagentExplorerReasoningEffort: z
    .enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional()
    .describe('Reasoning effort override for the explorer subagent. Falls back to agent.reasoningEffort when unset.'),
  subagentWorkerModel: z
    .string()
    .min(1)
    .optional()
    .describe('Model override for the worker subagent. Falls back to agent.model when unset.'),
  subagentWorkerProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider override for the worker subagent. Falls back to agent.provider when unset.'),
  subagentWorkerReasoningEffort: z
    .enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional()
    .describe('Reasoning effort override for the worker subagent. Falls back to agent.reasoningEffort when unset.'),
  subagentResearcherModel: z
    .string()
    .min(1)
    .optional()
    .describe('Model override for the researcher subagent. Falls back to agent.model when unset.'),
  subagentResearcherProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider override for the researcher subagent. Falls back to agent.provider when unset.'),
  subagentResearcherReasoningEffort: z
    .enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional()
    .describe('Reasoning effort override for the researcher subagent. Falls back to agent.reasoningEffort when unset.'),
});

export const ShellSettingsSchema = z.object({
  timeout: z.number().int().positive().default(120000),
  maxOutputLines: z.number().int().positive().default(1000),
  maxOutputChars: z.number().int().positive().default(40000),
  autoApproveMode: z.enum(['off', 'advisory', 'auto']).default('off').describe('Mode for shell command auto-approval'),
  useRtkCompression: z.boolean().optional().default(false).describe('Use RTK to compress shell command output'),
});

export const SandboxSettingsSchema = z.object({
  enabled: z.boolean().optional().default(true),
});

export const UISettingsSchema = z.object({
  historySize: z.number().int().positive().default(1000),
  pasteThreshold: z
    .number()
    .int()
    .positive()
    .default(3000)
    .describe('Max paste length before text is replaced by a placeholder'),
  displayMode: z
    .enum(['standard', 'concise'])
    .default('standard')
    .describe('Display mode for rendering conversation output'),
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
  // liteMode: minimal context for general terminal assistance (no codebase tools/prompts)
  // planMode: when enabled, forces read-only operation (Plan mode)
  // orchestratorMode: parent only delegates tool-backed work through run_subagent
  // Standard mode is the default (all flags false): full capabilities with auto-approve for apply_patch
  mentorMode: z.boolean().optional().default(false),
  liteMode: z.boolean().optional().default(false),
  planMode: z.boolean().optional().default(false),
  orchestratorMode: z.boolean().optional().default(false),
  notifications: z
    .boolean()
    .optional()
    .default(true)
    .describe('Enable desktop notifications when the terminal is unfocused (true|false)'),
  notificationsOnApproval: z
    .boolean()
    .optional()
    .default(true)
    .describe('Notify when the agent pauses awaiting tool-call approval (true|false)'),
  notificationsOnComplete: z
    .boolean()
    .optional()
    .default(true)
    .describe('Notify when the agent finishes responding (true|false)'),
  searchViaShell: z
    .union([z.boolean(), z.enum(['auto', 'on', 'off'])])
    .transform((val) => (typeof val === 'boolean' ? (val ? 'on' : 'off') : val))
    .optional()
    .default('auto'),
});

export const ToolsSettingsSchema = z.object({
  logFileOperations: z.boolean().optional().default(true),
  enableEditHealing: z.boolean().optional().default(true),
  editHealingModel: z.string().optional().default('gpt-4o-mini'),
  editHealingProvider: z
    .string()
    .min(1)
    .optional()
    .describe('Provider to use for the edit-healing model (defaults to agent.provider when unset)'),
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
  exa: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
});

export const KNOWN_CUSTOM_PROVIDER_TYPES = [
  'openai',
  'openai-compatible',
  'llama.cpp',
  'anthropic',
  'google',
  'opencode',
] as const;

export type KnownCustomProviderType = (typeof KNOWN_CUSTOM_PROVIDER_TYPES)[number];

export function isKnownCustomProviderType(value: string): value is KnownCustomProviderType {
  return (KNOWN_CUSTOM_PROVIDER_TYPES as readonly string[]).includes(value);
}

export const CustomProviderTypeSchema = z.enum(KNOWN_CUSTOM_PROVIDER_TYPES).default('openai-compatible');

export const CustomProviderSchema = z
  .object({
    name: z.string().min(1),
    type: CustomProviderTypeSchema,
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type !== 'anthropic' && data.type !== 'google' && data.type !== 'opencode' && !data.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseUrl is required for this provider type',
        path: ['baseUrl'],
      });
    }
  });

/**
 * Settings that are sensitive and should NEVER be saved to disk.
 * These are only loaded from environment variables.
 */
export function getSensitiveSettingKeys(): Set<string> {
  return new Set<string>([
    'app.shellPath',
    'agent.openrouter.baseUrl',
    'agent.openrouter.referrer',
    'agent.openrouter.title',
  ]);
}

export const SENSITIVE_SETTING_KEYS = getSensitiveSettingKeys();

export const SettingsSchema = z.object({
  providers: z.array(CustomProviderSchema).optional().default([]),
  providerOrder: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Preferred order of provider IDs for display in model selection tab bar'),
  agent: AgentSettingsSchema.optional(),
  shell: ShellSettingsSchema.optional(),
  sandbox: SandboxSettingsSchema.optional(),
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
  providerOrder: string[];
  agent: z.infer<typeof AgentSettingsSchema>;
  shell: z.infer<typeof ShellSettingsSchema>;
  sandbox: z.infer<typeof SandboxSettingsSchema>;
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
    transport: SettingWithSource<'websocket' | 'http'>;
    maxParallelToolCalls: SettingWithSource<number>;
    provider: SettingWithSource<string>;
    openrouter: SettingWithSource<any>;
    openai: SettingWithSource<any>;
    mentorModel: SettingWithSource<string | undefined>;
    mentorProvider: SettingWithSource<string | undefined>;
    mentorReasoningEffort: SettingWithSource<string>;
    useFlexServiceTier: SettingWithSource<boolean>;
    autoApproveModel: SettingWithSource<string>;
    autoApproveProvider: SettingWithSource<string | undefined>;
    subagentExplorerModel: SettingWithSource<string | undefined>;
    subagentExplorerProvider: SettingWithSource<string | undefined>;
    subagentExplorerReasoningEffort: SettingWithSource<string | undefined>;
    subagentWorkerModel: SettingWithSource<string | undefined>;
    subagentWorkerProvider: SettingWithSource<string | undefined>;
    subagentWorkerReasoningEffort: SettingWithSource<string | undefined>;
    subagentResearcherModel: SettingWithSource<string | undefined>;
    subagentResearcherProvider: SettingWithSource<string | undefined>;
    subagentResearcherReasoningEffort: SettingWithSource<string | undefined>;
  };
  shell: {
    timeout: SettingWithSource<number>;
    maxOutputLines: SettingWithSource<number>;
    maxOutputChars: SettingWithSource<number>;
    autoApproveMode: SettingWithSource<'off' | 'advisory' | 'auto'>;
    useRtkCompression: SettingWithSource<boolean>;
  };
  sandbox: {
    enabled: SettingWithSource<boolean>;
  };
  ui: {
    historySize: SettingWithSource<number>;
    pasteThreshold: SettingWithSource<number | undefined>;
    displayMode: SettingWithSource<'standard' | 'concise'>;
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
    liteMode: SettingWithSource<boolean>;
    planMode: SettingWithSource<boolean>;
    orchestratorMode: SettingWithSource<boolean>;
    notifications: SettingWithSource<boolean>;
    notificationsOnApproval: SettingWithSource<boolean>;
    notificationsOnComplete: SettingWithSource<boolean>;
    searchViaShell: SettingWithSource<'auto' | 'on' | 'off'>;
  };
  tools: {
    logFileOperations: SettingWithSource<boolean>;
    enableEditHealing: SettingWithSource<boolean>;
    editHealingModel: SettingWithSource<string>;
    editHealingProvider: SettingWithSource<string | undefined>;
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
    exa: SettingWithSource<{ apiKey?: string } | undefined>;
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
  AGENT_TRANSPORT: 'agent.transport',
  AGENT_MAX_PARALLEL_TOOL_CALLS: 'agent.maxParallelToolCalls',
  AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
  AGENT_OPENAI_API_KEY: 'agent.openai.apiKey',
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
  SHELL_AUTO_APPROVE_MODE: 'shell.autoApproveMode',
  SHELL_USE_RTK_COMPRESSION: 'shell.useRtkCompression',
  SANDBOX_ENABLED: 'sandbox.enabled',
  AGENT_AUTO_APPROVE_MODEL: 'agent.autoApproveModel',
  AGENT_AUTO_APPROVE_PROVIDER: 'agent.autoApproveProvider',
  AGENT_SUBAGENT_EXPLORER_MODEL: 'agent.subagentExplorerModel',
  AGENT_SUBAGENT_EXPLORER_PROVIDER: 'agent.subagentExplorerProvider',
  AGENT_SUBAGENT_EXPLORER_REASONING_EFFORT: 'agent.subagentExplorerReasoningEffort',
  AGENT_SUBAGENT_WORKER_MODEL: 'agent.subagentWorkerModel',
  AGENT_SUBAGENT_WORKER_PROVIDER: 'agent.subagentWorkerProvider',
  AGENT_SUBAGENT_WORKER_REASONING_EFFORT: 'agent.subagentWorkerReasoningEffort',
  AGENT_SUBAGENT_RESEARCHER_MODEL: 'agent.subagentResearcherModel',
  AGENT_SUBAGENT_RESEARCHER_PROVIDER: 'agent.subagentResearcherProvider',
  AGENT_SUBAGENT_RESEARCHER_REASONING_EFFORT: 'agent.subagentResearcherReasoningEffort',
  UI_HISTORY_SIZE: 'ui.historySize',
  UI_PASTE_THRESHOLD: 'ui.pasteThreshold',
  UI_DISPLAY_MODE: 'ui.displayMode',
  LOGGING_LOG_LEVEL: 'logging.logLevel',
  LOGGING_DISABLE: 'logging.disableLogging',
  LOGGING_DEBUG: 'logging.debugLogging',
  LOGGING_SUPPRESS_CONSOLE: 'logging.suppressConsoleOutput',
  ENV_NODE_ENV: 'environment.nodeEnv',
  APP_SHELL_PATH: 'app.shellPath',
  APP_MENTOR_MODE: 'app.mentorMode',
  APP_LITE_MODE: 'app.liteMode',
  APP_PLAN_MODE: 'app.planMode',
  APP_ORCHESTRATOR_MODE: 'app.orchestratorMode',
  APP_NOTIFICATIONS: 'app.notifications',
  APP_NOTIFICATIONS_ON_APPROVAL: 'app.notificationsOnApproval',
  APP_NOTIFICATIONS_ON_COMPLETE: 'app.notificationsOnComplete',
  APP_SEARCH_VIA_SHELL: 'app.searchViaShell',
  TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
  TOOLS_ENABLE_EDIT_HEALING: 'tools.enableEditHealing',
  TOOLS_EDIT_HEALING_MODEL: 'tools.editHealingModel',
  TOOLS_EDIT_HEALING_PROVIDER: 'tools.editHealingProvider',
  DEBUG_BASH_TOOL: 'debug.debugBashTool',
  SSH_ENABLED: 'ssh.enabled',
  SSH_HOST: 'ssh.host',
  SSH_PORT: 'ssh.port',
  SSH_USERNAME: 'ssh.username',
  SSH_REMOTE_DIR: 'ssh.remoteDir',
  WEB_SEARCH_PROVIDER: 'webSearch.provider',
  WEB_SEARCH_TAVILY_API_KEY: 'webSearch.tavily.apiKey',
  WEB_SEARCH_EXA_API_KEY: 'webSearch.exa.apiKey',
  PROVIDER_ORDER: 'providerOrder',
} as const;

// Define which settings are modifiable at runtime
export const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>([
  SETTING_KEYS.AGENT_OPENROUTER_API_KEY,
  SETTING_KEYS.AGENT_OPENAI_API_KEY,
  SETTING_KEYS.AGENT_MODEL,
  SETTING_KEYS.AGENT_REASONING_EFFORT,
  SETTING_KEYS.AGENT_TEMPERATURE,
  SETTING_KEYS.AGENT_PROVIDER,
  SETTING_KEYS.AGENT_RETRY_ATTEMPTS,
  SETTING_KEYS.AGENT_TRANSPORT,
  SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS,
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
  SETTING_KEYS.APP_LITE_MODE,
  SETTING_KEYS.APP_PLAN_MODE,
  SETTING_KEYS.APP_ORCHESTRATOR_MODE,
  SETTING_KEYS.APP_NOTIFICATIONS,
  SETTING_KEYS.APP_NOTIFICATIONS_ON_APPROVAL,
  SETTING_KEYS.APP_NOTIFICATIONS_ON_COMPLETE,
  SETTING_KEYS.APP_SEARCH_VIA_SHELL,
  SETTING_KEYS.SHELL_AUTO_APPROVE_MODE,
  SETTING_KEYS.SHELL_USE_RTK_COMPRESSION,
  SETTING_KEYS.SANDBOX_ENABLED,
  SETTING_KEYS.UI_PASTE_THRESHOLD,
  SETTING_KEYS.UI_DISPLAY_MODE,
  SETTING_KEYS.AGENT_AUTO_APPROVE_MODEL,
  SETTING_KEYS.AGENT_AUTO_APPROVE_PROVIDER,
  SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_MODEL,
  SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_PROVIDER,
  SETTING_KEYS.AGENT_SUBAGENT_EXPLORER_REASONING_EFFORT,
  SETTING_KEYS.AGENT_SUBAGENT_WORKER_MODEL,
  SETTING_KEYS.AGENT_SUBAGENT_WORKER_PROVIDER,
  SETTING_KEYS.AGENT_SUBAGENT_WORKER_REASONING_EFFORT,
  SETTING_KEYS.AGENT_SUBAGENT_RESEARCHER_MODEL,
  SETTING_KEYS.AGENT_SUBAGENT_RESEARCHER_PROVIDER,
  SETTING_KEYS.AGENT_SUBAGENT_RESEARCHER_REASONING_EFFORT,
  SETTING_KEYS.TOOLS_EDIT_HEALING_MODEL,
  SETTING_KEYS.TOOLS_EDIT_HEALING_PROVIDER,
  SETTING_KEYS.WEB_SEARCH_PROVIDER,
  SETTING_KEYS.WEB_SEARCH_TAVILY_API_KEY,
  SETTING_KEYS.WEB_SEARCH_EXA_API_KEY,
  SETTING_KEYS.PROVIDER_ORDER,
]);

export interface AppModes {
  orchestratorMode: boolean;
  liteMode: boolean;
  planMode: boolean;
  mentorMode: boolean;
}

/**
 * Normalize app mode flags to enforce mutual exclusion.
 *
 * Precedence (first one that is true wins; all others are disabled):
 *   orchestratorMode > liteMode > planMode > mentorMode
 *
 * When none are true, all remain false (standard mode).
 */
export function normalizeAppModes(modes: AppModes): AppModes {
  if (modes.orchestratorMode) {
    return { orchestratorMode: true, liteMode: false, planMode: false, mentorMode: false };
  }
  if (modes.liteMode) {
    return { orchestratorMode: false, liteMode: true, planMode: false, mentorMode: false };
  }
  if (modes.planMode) {
    return { orchestratorMode: false, liteMode: false, planMode: true, mentorMode: false };
  }
  if (modes.mentorMode) {
    return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: true };
  }
  return { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: false };
}

// Some settings with default values are optional to persist
export const OPTIONAL_DEFAULT_KEYS = new Set<string>([]);

// Default settings
export const DEFAULT_SETTINGS: SettingsData = {
  providers: [],
  providerOrder: [],
  agent: {
    model: 'gpt-5.1',
    reasoningEffort: 'default',
    maxTurns: 100,
    retryAttempts: 2,
    transport: 'websocket',
    maxParallelToolCalls: 3,
    provider: 'openai',
    openrouter: {
      // defaults empty; can be provided via env or config
      // defaults empty; can be provided via env or config
    } as any,
    openai: {
      // defaults empty; can be provided via env or config
    } as any,
    mentorModel: undefined,
    mentorProvider: undefined,
    mentorReasoningEffort: 'default',
    useFlexServiceTier: false,
    autoApproveModel: 'gpt-4o-mini',
    autoApproveProvider: undefined,
    subagentExplorerModel: undefined,
    subagentExplorerProvider: undefined,
    subagentExplorerReasoningEffort: undefined,
    subagentWorkerModel: undefined,
    subagentWorkerProvider: undefined,
    subagentWorkerReasoningEffort: undefined,
    subagentResearcherModel: undefined,
    subagentResearcherProvider: undefined,
    subagentResearcherReasoningEffort: undefined,
  },
  shell: {
    timeout: 120000,
    maxOutputLines: 1000,
    maxOutputChars: 40000,
    autoApproveMode: 'off',
    useRtkCompression: false,
  },
  sandbox: {
    enabled: true,
  },
  ui: {
    historySize: 1000,
    pasteThreshold: 3000,
    displayMode: 'standard',
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
    liteMode: false,
    planMode: false,
    orchestratorMode: false,
    notifications: true,
    notificationsOnApproval: true,
    notificationsOnComplete: true,
    searchViaShell: 'auto',
  },
  tools: {
    logFileOperations: true,
    enableEditHealing: true,
    editHealingModel: 'gpt-4o-mini',
    editHealingProvider: undefined,
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
    exa: {},
  },
};

/**
 * Publicly exported list of sensitive settings for UI/CLI components to use.
 * These settings should only be configured via environment variables.
 */
export const SENSITIVE_SETTINGS = {
  AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
  AGENT_OPENAI_API_KEY: 'agent.openai.apiKey',
  AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl',
  AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer',
  AGENT_OPENROUTER_TITLE: 'agent.openrouter.title',
  APP_SHELL_PATH: 'app.shellPath',
} as const;
