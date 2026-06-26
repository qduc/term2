import { SETTING_KEYS } from '../services/settings/settings-service.js';

export type SettingCompletionItem = {
  key: string;
  description?: string;
  currentValue?: string | number | boolean;
};

export type SettingsCategory = {
  id: string;
  label: string;
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'model', label: 'Model & Reasoning' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'approvals', label: 'Safety & Approvals' },
  { id: 'shell', label: 'Shell Execution' },
  { id: 'search', label: 'Search & Web' },
  { id: 'uiLogging', label: 'UI & Logging' },
  { id: 'advanced', label: 'Advanced' },
];

export const SETTING_DESCRIPTIONS: Record<string, string> = {
  [SETTING_KEYS.AGENT_MODEL]: 'The AI model to use (e.g. gpt-4, claude-3-opus)',
  [SETTING_KEYS.AGENT_REASONING_EFFORT]: 'Reasoning effort (none|minimal|low|medium|high|xhigh|default)',
  [SETTING_KEYS.AGENT_TEMPERATURE]: 'Model temperature (0-2, controls randomness)',
  [SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER]: 'Use OpenAI Flex Service Tier to reduce costs (true|false, OpenAI only)',
  [SETTING_KEYS.AGENT_MENTOR_MODEL]: 'Mentor model to use (optional, enables ask_mentor tool)',
  [SETTING_KEYS.AGENT_MENTOR_PROVIDER]: 'Provider to use for mentor model (openai, openrouter, etc.)',
  [SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT]:
    'Reasoning effort for the mentor model (none|minimal|low|medium|high|xhigh|default)',
  // agent.provider is hidden from UI - it can only be changed via model menu
  [SETTING_KEYS.AGENT_MAX_TURNS]: 'Maximum conversation turns',
  [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]: 'Number of retry attempts for failed requests',
  [SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS]: 'Maximum number of tool calls allowed to run at the same time',
  [SETTING_KEYS.SHELL_TIMEOUT]: 'Shell command timeout in milliseconds',
  [SETTING_KEYS.SHELL_MAX_OUTPUT_LINES]: 'Maximum lines of shell output to capture',
  [SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS]: 'Maximum characters of shell output to capture',
  [SETTING_KEYS.UI_HISTORY_SIZE]: 'Number of history items to keep',
  [SETTING_KEYS.UI_DISPLAY_MODE]: 'Display mode for rendering output (standard|concise)',
  [SETTING_KEYS.LOGGING_LOG_LEVEL]: 'Logging level (debug, info, warn, error)',
  [SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE]: 'Suppress console output (true|false) to avoid interfering with Ink UI',
  [SETTING_KEYS.TOOLS_ENABLE_EDIT_HEALING]: 'Use AI to automatically correct failed search_replace operations',
  [SETTING_KEYS.TOOLS_EDIT_HEALING_MODEL]: 'Model to use for edit healing (fast/cheap)',
  [SETTING_KEYS.TOOLS_EDIT_HEALING_PROVIDER]: 'Provider for the edit-healing model (optional)',
  [SETTING_KEYS.SHELL_AUTO_APPROVE_MODE]: 'Shell command auto-approval mode (off|advisory|auto)',
  [SETTING_KEYS.AGENT_AUTO_APPROVE_MODEL]: 'Model to use for auto-approval evaluation (fast/cheap)',
  [SETTING_KEYS.AGENT_AUTO_APPROVE_PROVIDER]: 'Provider for the auto-approval model (optional)',
  [SETTING_KEYS.APP_PLAN_MODE]: 'Plan mode: read-only research and implementation planning (true|false)',
  [SETTING_KEYS.APP_ORCHESTRATOR_MODE]: 'Delegate tool-backed work through subagents (true|false)',
  [SETTING_KEYS.APP_NOTIFICATIONS]: 'Enable desktop notifications when the terminal is unfocused (true|false)',
  [SETTING_KEYS.APP_NOTIFICATIONS_ON_APPROVAL]: 'Notify when the agent needs tool-call approval (true|false)',
  [SETTING_KEYS.APP_NOTIFICATIONS_ON_COMPLETE]: 'Notify when the agent finishes responding (true|false)',
  [SETTING_KEYS.WEB_SEARCH_PROVIDER]: 'Web search provider (tavily, exa)',
  [SETTING_KEYS.APP_SEARCH_VIA_SHELL]:
    'Use shell commands (ripgrep/find) for codebase search instead of built-in tools (true|false)',
  [SETTING_KEYS.SHELL_USE_RTK_COMPRESSION]:
    'Use RTK (third-party) to compress shell command output; term2 downloads it automatically (true|false)',
  [SETTING_KEYS.SANDBOX_ENABLED]: 'Enable sandbox mode for safer command execution (true|false)',
  [SETTING_KEYS.SANDBOX_READ_POLICY]: 'File read policy for sandbox (standard|strict)',
  [SETTING_KEYS.SANDBOX_ALLOW_READ_EXTRA]: 'Additional paths allowed for sandbox file reads (comma-separated)',
};

/**
 * Settings that should be hidden from the UI (not for security, but for UX/workflow)
 * - agent.provider: Can only be changed at the start of a new conversation via model menu
 * - agent.autoApproveProvider: Controlled via model/provider selection workflows, hide from the general settings list
 */
export const HIDDEN_SETTINGS = new Set<string>([
  SETTING_KEYS.AGENT_PROVIDER,
  SETTING_KEYS.AGENT_AUTO_APPROVE_PROVIDER,
  SETTING_KEYS.AGENT_MENTOR_PROVIDER,
  SETTING_KEYS.TOOLS_EDIT_HEALING_PROVIDER,
  SETTING_KEYS.PROVIDER_ORDER,
  SETTING_KEYS.LOGGING_DEBUG,
  SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE,
  SETTING_KEYS.ENV_NODE_ENV,
  SETTING_KEYS.APP_SHELL_PATH,
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
]);

export const COMMON_SETTINGS: string[] = [
  SETTING_KEYS.AGENT_MODEL,
  SETTING_KEYS.AGENT_REASONING_EFFORT,
  SETTING_KEYS.AGENT_TEMPERATURE,
];

export const CATEGORY_KEYS = {
  model: new Set<string>([
    SETTING_KEYS.AGENT_MODEL,
    SETTING_KEYS.AGENT_REASONING_EFFORT,
    SETTING_KEYS.AGENT_TEMPERATURE,
    SETTING_KEYS.AGENT_MENTOR_MODEL,
    SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT,
    SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER,
  ]),
  modes: new Set<string>([
    SETTING_KEYS.APP_PLAN_MODE,
    SETTING_KEYS.APP_ORCHESTRATOR_MODE,
    SETTING_KEYS.APP_MENTOR_MODE,
    SETTING_KEYS.APP_LITE_MODE,
  ]),
  approvals: new Set<string>([SETTING_KEYS.SHELL_AUTO_APPROVE_MODE, SETTING_KEYS.AGENT_AUTO_APPROVE_MODEL]),
  shell: new Set<string>([
    SETTING_KEYS.SHELL_TIMEOUT,
    SETTING_KEYS.SHELL_MAX_OUTPUT_LINES,
    SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS,
    SETTING_KEYS.SHELL_USE_RTK_COMPRESSION,
    SETTING_KEYS.SANDBOX_ENABLED,
    SETTING_KEYS.SANDBOX_READ_POLICY,
    SETTING_KEYS.SANDBOX_ALLOW_READ_EXTRA,
  ]),
  search: new Set<string>([SETTING_KEYS.WEB_SEARCH_PROVIDER, SETTING_KEYS.APP_SEARCH_VIA_SHELL]),
  uiLogging: new Set<string>([
    SETTING_KEYS.UI_HISTORY_SIZE,
    SETTING_KEYS.UI_PASTE_THRESHOLD,
    SETTING_KEYS.UI_DISPLAY_MODE,
    SETTING_KEYS.LOGGING_LOG_LEVEL,
    SETTING_KEYS.LOGGING_DISABLE,
    SETTING_KEYS.APP_NOTIFICATIONS,
    SETTING_KEYS.APP_NOTIFICATIONS_ON_APPROVAL,
    SETTING_KEYS.APP_NOTIFICATIONS_ON_COMPLETE,
  ]),
} as const;

export const CATEGORY_ORDER: Array<keyof typeof CATEGORY_KEYS> = [
  'model',
  'modes',
  'approvals',
  'shell',
  'search',
  'uiLogging',
];
