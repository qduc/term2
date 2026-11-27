import type { SettingsProjection } from '../../../lib/term2/types';
import {
  CONTEXT_ITEMS,
  LIMIT_ITEMS,
  MODEL_ITEMS,
  PARITY_DEFAULTS,
  PERMISSION_ITEMS,
  TOOL_ITEMS,
} from './settings-catalog-parity';

/** The settings page's sections, in menu order. The id is the `?settings=` URL value. */
export const SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'safety', label: 'Approvals and safety' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'tools', label: 'Tools' },
  { id: 'web-search', label: 'Web search' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** `null` when settings is closed; an unknown value opens the first section. */
export function parseSettingsSection(raw: string | null | undefined): SettingsSectionId | null {
  if (raw === null || raw === undefined) return null;
  return SETTINGS_SECTIONS.some((section) => section.id === raw) ? (raw as SettingsSectionId) : 'providers';
}

export function sectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

export interface SettingOption {
  value: string;
  label: string;
  /** One line shown under the row while this option is selected. */
  hint?: string;
}

/**
 * One row on the settings page.
 * - `server`: gateway settings-projection keys (`id` is the key unless `keys` lists several).
 * - `local`: a preference kept in this browser.
 * - `credential`: an API key the gateway holds and never returns.
 * - `info`: read-only facts (the sandbox summary), searchable like a setting.
 */
export interface SettingItem {
  id: string;
  section: SettingsSectionId;
  group?: string;
  source: 'server' | 'local' | 'credential' | 'info';
  kind:
    | 'boolean'
    | 'number'
    | 'select'
    | 'text'
    | 'credential'
    | 'compaction'
    | 'duration-limit'
    | 'info'
    | 'model-pool'
    | 'model-tier'
    | 'favorites'
    | 'nicknames'
    | 'revoke-list';
  label: string;
  description: string;
  /** Everyday words search also matches ("dark" finds the theme). */
  keywords?: string[];
  options?: SettingOption[];
  /** Shown while the value is empty: what applies instead (a text field's or select's placeholder). */
  placeholder?: string;
  /** Unit shown after a number, in display units. */
  unit?: string;
  /** Display value = stored value × factor (for example ms → s is 0.001). Writes divide it back. */
  factor?: number;
  min?: number;
  max?: number;
  step?: string;
  /** The stored value must be a whole number (counts, milliseconds). */
  integer?: boolean;
  /** Gateway keys the row reads and writes. Defaults to `[id]` for server rows. */
  keys?: string[];
  /** Rows that only matter for one choice (a search provider's address or key). */
  visibleWhen?: (projection: SettingsProjection) => boolean;
}

/**
 * Built-in defaults, copied from `src/config/settings/settings-schema.ts`. The settings file
 * stores every value once term2 has run, so a setting's source cannot tell a changed value from a
 * default; the page compares against these instead.
 */
export const SERVER_DEFAULTS: Record<string, unknown> = {
  'shell.autoApproveMode': 'off',
  'shell.showReview': false,
  'agent.contextCompaction.enabled': true,
  'agent.contextCompaction.threshold': 0.8,
  'memory.enabled': true,
  'agent.maxTurns': 100,
  'agent.maxParallelToolCalls': 3,
  'agent.retryAttempts': 2,
  'shell.timeout': 120000,
  'shell.maxOutputLines': 1000,
  'tools.maxOutputChars': 20000,
  'agent.maxOutputTokens': 32000,
  'agent.maxStreamOutputChars': 100000,
  'agent.maxModelRequestDurationMs': 0,
  'webSearch.provider': 'tavily',
  'webSearch.searxng.baseUrl': undefined,
  'webSearch.firecrawl.baseUrl': undefined,
  'logging.logLevel': 'info',
  ...PARITY_DEFAULTS,
};

export function differsFromDefault(key: string, value: unknown): boolean {
  if (!(key in SERVER_DEFAULTS)) return false;
  const fallback = SERVER_DEFAULTS[key];
  const empty = (candidate: unknown) =>
    candidate === undefined ||
    candidate === null ||
    candidate === '' ||
    (Array.isArray(candidate) && candidate.length === 0) ||
    (typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).length === 0);
  if (empty(fallback)) return !empty(value);
  return JSON.stringify(value) !== JSON.stringify(fallback);
}

/**
 * Keys the gateway exposes that the web page deliberately never shows: retired or per-chat modes,
 * and the model defaults that are being replaced. Their stored values are left untouched.
 */
export const NEVER_SHOWN_KEYS = new Set([
  'app.liteMode',
  'app.activeProfileId',
  'app.mentorMode',
  'app.planMode',
  'app.orchestratorMode',
  'agent.temperature',
  'agent.modelSelection',
  'agent.reasoningEffort',
]);

const SEARCH_PROVIDERS = ['tavily', 'exa', 'firecrawl', 'searxng'];

/** The search provider in effect: the gateway falls back to Tavily for any unknown value. */
export function effectiveSearchProvider(projection: SettingsProjection): string {
  const value = projection.settings.safeDefaults['webSearch.provider']?.value;
  return typeof value === 'string' && SEARCH_PROVIDERS.includes(value) ? value : 'tavily';
}

const searchProviderIs = (id: string) => (projection: SettingsProjection) => effectiveSearchProvider(projection) === id;

export const SETTING_ITEMS: SettingItem[] = [
  // Approvals and safety
  {
    id: 'shell.autoApproveMode',
    section: 'safety',
    source: 'server',
    kind: 'select',
    label: 'Default approval mode',
    keywords: ['permissions', 'permission', 'ask', 'approve', 'auto approve', 'always', 'confirm', 'yolo'],
    description: 'Applies to new chats. Each chat can change it from the composer.',
    options: [
      { value: 'off', label: 'Ask every time', hint: 'term2 asks before every command and file edit.' },
      {
        value: 'auto',
        label: 'Auto-approve safe commands',
        hint: 'Read-only and known-safe commands run without asking; everything else asks.',
      },
      {
        value: 'unattended',
        label: 'Unattended',
        hint: 'Never asks. Actions the safety reviewer approves run; the rest are refused.',
      },
      {
        value: 'always',
        label: 'Approve everything',
        hint: 'Every action runs without asking. Sandbox settings still apply.',
      },
    ],
  },
  {
    id: 'shell.showReview',
    section: 'safety',
    source: 'server',
    kind: 'boolean',
    label: 'Show the safety review',
    keywords: ['reviewer', 'review', 'safety', 'why', 'explanation', 'permission'],
    description:
      'When term2 asks for permission, also show what the safety reviewer thought. It never approves anything by itself.',
  },

  {
    id: 'info:sandbox',
    section: 'safety',
    source: 'info',
    kind: 'info',
    label: 'Sandbox and network',
    description: 'What applies to shell commands right now.',
    keywords: ['sandbox', 'isolation', 'isolated', 'network', 'internet access', 'confined', 'folder access'],
  },

  ...PERMISSION_ITEMS,

  // Conversation
  {
    id: 'memory.enabled',
    section: 'conversation',
    source: 'server',
    kind: 'boolean',
    label: 'Personal memory',
    keywords: ['remember', 'memory', 'forget', 'preferences'],
    description: 'Let term2 remember preferences and facts across conversations.',
  },
  {
    id: 'compaction',
    section: 'conversation',
    source: 'server',
    kind: 'compaction',
    label: 'Automatic context compaction',
    keywords: ['context', 'summarize', 'summary', 'long chat', 'compact', 'token limit', 'context window'],
    description: 'Summarize older turns so long conversations keep fitting in the model’s context window.',
    keys: ['agent.contextCompaction.enabled', 'agent.contextCompaction.threshold'],
    unit: '% full',
    factor: 100,
    min: 10,
    max: 95,
    step: '5',
  },

  ...CONTEXT_ITEMS,
  ...TOOL_ITEMS,
  ...MODEL_ITEMS,
  ...LIMIT_ITEMS,

  // Web search
  {
    id: 'webSearch.provider',
    section: 'web-search',
    source: 'server',
    kind: 'select',
    label: 'Search provider',
    keywords: ['search', 'internet', 'browse', 'web', 'online', 'lookup'],
    description: 'The search service used when the assistant looks things up online.',
    options: [
      { value: 'tavily', label: 'Tavily', hint: 'Needs a Tavily API key.' },
      { value: 'exa', label: 'Exa', hint: 'Needs an Exa API key.' },
      { value: 'firecrawl', label: 'Firecrawl', hint: 'Needs a Firecrawl API key, or your own Firecrawl server.' },
      { value: 'searxng', label: 'SearXNG', hint: 'Uses your own SearXNG server. No key needed.' },
    ],
  },
  {
    id: 'credential:tavily',
    section: 'web-search',
    source: 'credential',
    kind: 'credential',
    label: 'Tavily API key',
    keywords: ['api key', 'key', 'token', 'search'],
    description: 'From your Tavily account.',
    visibleWhen: searchProviderIs('tavily'),
  },
  {
    id: 'credential:exa',
    section: 'web-search',
    source: 'credential',
    kind: 'credential',
    label: 'Exa API key',
    keywords: ['api key', 'key', 'token', 'search'],
    description: 'From your Exa account.',
    visibleWhen: searchProviderIs('exa'),
  },
  {
    id: 'credential:firecrawl',
    section: 'web-search',
    source: 'credential',
    kind: 'credential',
    label: 'Firecrawl API key',
    keywords: ['api key', 'key', 'token', 'search'],
    description: 'From your Firecrawl account. Not needed for a self-hosted server without a key.',
    visibleWhen: searchProviderIs('firecrawl'),
  },
  {
    id: 'webSearch.firecrawl.baseUrl',
    section: 'web-search',
    source: 'server',
    kind: 'text',
    label: 'Firecrawl server address',
    keywords: ['url', 'base url', 'self-hosted', 'endpoint'],
    description: 'Only for a self-hosted Firecrawl. Leave empty to use the hosted service.',
    visibleWhen: searchProviderIs('firecrawl'),
  },
  {
    id: 'webSearch.searxng.baseUrl',
    section: 'web-search',
    source: 'server',
    kind: 'text',
    label: 'SearXNG server address',
    keywords: ['url', 'base url', 'self-hosted', 'endpoint', 'searx'],
    description: 'The URL of your SearXNG instance.',
    visibleWhen: searchProviderIs('searxng'),
  },

  // Appearance (kept in this browser)
  {
    id: 'local:theme',
    section: 'appearance',
    source: 'local',
    kind: 'select',
    label: 'Color theme',
    keywords: ['dark', 'light', 'dark mode', 'colour', 'color', 'appearance', 'night'],
    description: 'Follow your system, or always use light or dark.',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  {
    id: 'local:displayMode',
    section: 'appearance',
    source: 'local',
    kind: 'select',
    label: 'Tool activity display',
    keywords: ['tools', 'compact', 'verbose', 'detailed', 'standard', 'concise', 'collapse'],
    description: 'How tool calls appear in the conversation. Click any row to see its full input and output.',
    options: [
      {
        value: 'concise',
        label: 'Concise',
        hint: 'Each run of tool calls folds into one line; reasoning is hidden.',
      },
      { value: 'standard', label: 'Standard', hint: 'One row per tool call.' },
    ],
  },
  {
    id: 'local:notifications',
    section: 'appearance',
    source: 'local',
    kind: 'boolean',
    label: 'Browser notifications',
    keywords: ['notify', 'alert', 'sound', 'background', 'desktop notification'],
    description: 'Notify you when a background tab needs approval or finishes a reply.',
  },
  {
    id: 'local:diagnostics',
    section: 'appearance',
    source: 'local',
    kind: 'boolean',
    label: 'Diagnostics',
    keywords: ['debug', 'raw', 'developer', 'state'],
    description: 'Show raw session state under the transcript.',
  },

  // Advanced → Limits
  {
    id: 'agent.maxTurns',
    integer: true,
    section: 'advanced',
    group: 'Per turn',
    source: 'server',
    kind: 'number',
    label: 'Steps per turn',
    keywords: ['max turns', 'runaway', 'loop', 'rounds', 'steps', 'limit'],
    description: 'Stops a runaway turn: term2 pauses and asks after this many tool rounds.',
    unit: 'steps',
    min: 1,
  },
  {
    id: 'agent.maxParallelToolCalls',
    integer: true,
    section: 'advanced',
    group: 'Per turn',
    source: 'server',
    kind: 'number',
    label: 'Parallel tool calls',
    keywords: ['concurrent', 'concurrency', 'simultaneous', 'at once', 'parallel'],
    description: 'How many tools may run at once, so one turn can’t flood your machine.',
    unit: 'at once',
    min: 1,
  },
  {
    id: 'agent.retryAttempts',
    integer: true,
    section: 'advanced',
    group: 'Per turn',
    source: 'server',
    kind: 'number',
    label: 'Retries after network errors',
    keywords: ['retry', 'network', 'flaky', 'connection', 'error'],
    description: 'How often a model request that failed on a temporary error is tried again.',
    unit: 'retries',
    min: 0,
  },
  {
    id: 'shell.timeout',
    integer: true,
    section: 'advanced',
    group: 'Shell and tools',
    source: 'server',
    kind: 'number',
    label: 'Shell command timeout',
    keywords: ['timeout', 'slow', 'command takes too long', 'hang', 'stuck', 'terminal'],
    description: 'Stops a command that hangs or runs too long.',
    unit: 'seconds',
    factor: 0.001,
    min: 1,
  },
  {
    id: 'shell.maxOutputLines',
    integer: true,
    section: 'advanced',
    group: 'Shell and tools',
    source: 'server',
    kind: 'number',
    label: 'Shell output',
    keywords: ['lines', 'output', 'truncate', 'long output', 'terminal'],
    description: 'Shortens very long command output so it doesn’t fill the conversation.',
    unit: 'lines',
    min: 1,
  },
  {
    id: 'tools.maxOutputChars',
    integer: true,
    section: 'advanced',
    group: 'Shell and tools',
    source: 'server',
    kind: 'number',
    label: 'Tool output sent to the model',
    keywords: ['truncate', 'characters', 'output', 'large result', 'context'],
    description: 'Trims large tool results so they don’t use up the context window.',
    unit: 'characters',
    min: 1,
  },
  {
    id: 'agent.maxOutputTokens',
    integer: true,
    section: 'advanced',
    group: 'Model',
    source: 'server',
    kind: 'number',
    label: 'Reply length',
    keywords: ['max output tokens', 'tokens', 'long answer', 'response length'],
    description: 'Caps how much the model may write in one response.',
    unit: 'tokens',
    min: 1,
  },
  {
    id: 'agent.maxStreamOutputChars',
    integer: true,
    section: 'advanced',
    group: 'Model',
    source: 'server',
    kind: 'number',
    label: 'Streamed reply length',
    keywords: ['stream', 'characters', 'endless', 'runaway'],
    description: 'Stops a response that keeps streaming without end.',
    unit: 'characters',
    min: 1,
  },
  {
    id: 'agent.maxModelRequestDurationMs',
    integer: true,
    section: 'advanced',
    group: 'Model',
    source: 'server',
    kind: 'duration-limit',
    label: 'Model request time limit',
    keywords: ['timeout', 'hang', 'slow', 'stuck', 'duration', 'no limit'],
    description: 'Gives up on a model request that takes too long.',
    unit: 'seconds',
    factor: 0.001,
    min: 1,
  },

  // Advanced → Diagnostics
  {
    id: 'logging.logLevel',
    section: 'advanced',
    group: 'Diagnostics',
    source: 'server',
    kind: 'select',
    label: 'Log level',
    keywords: ['debug', 'logs', 'logging', 'verbose', 'troubleshoot'],
    description: 'How much detail term2 writes to its local diagnostic logs.',
    options: [
      { value: 'error', label: 'Errors only' },
      { value: 'warn', label: 'Warnings' },
      { value: 'info', label: 'Info' },
      { value: 'security', label: 'Security' },
      { value: 'debug', label: 'Debug' },
    ],
  },
];

export const LOCAL_DEFAULTS: Record<string, unknown> = {
  'local:theme': 'system',
  'local:displayMode': 'concise',
  'local:notifications': false,
  'local:diagnostics': false,
};

/** Gateway keys a row covers. */
export function itemKeys(item: SettingItem): string[] {
  if (item.source !== 'server') return [];
  return item.keys ?? [item.id];
}

/**
 * The rows to show for this projection: rows whose keys the gateway provides and whose condition
 * holds. Keys the gateway adds later are not shown until this catalog describes them.
 */
export function visibleItems(projection: SettingsProjection): SettingItem[] {
  const safeDefaults = projection.settings.safeDefaults;
  return SETTING_ITEMS.filter((item) => {
    if (item.source === 'server' && itemKeys(item).some((key) => !safeDefaults[key]?.persistable)) return false;
    if (item.source === 'credential' && !projection.settings.credentials[item.id.slice('credential:'.length)])
      return false;
    return !item.visibleWhen || item.visibleWhen(projection);
  });
}

/** Gateway keys that are neither described here nor deliberately hidden. */
export function undescribedKeys(projection: SettingsProjection): string[] {
  const described = new Set(SETTING_ITEMS.flatMap(itemKeys));
  return Object.keys(projection.settings.safeDefaults).filter(
    (key) => !described.has(key) && !NEVER_SHOWN_KEYS.has(key),
  );
}

/** Everyday words that lead to a whole section (search shows a link to it). */
export const SECTION_KEYWORDS: Record<SettingsSectionId, string[]> = {
  providers: [
    'api key', 'key', 'token', 'sign in', 'login', 'log in', 'account', 'model', 'models', 'provider',
    'openai', 'anthropic', 'claude', 'gemini', 'google', 'openrouter', 'ollama', 'grok', 'xai', 'codex',
    'llama', 'local model', 'server', 'base url',
  ],
  models: ['model', 'models', 'tier', 'helper', 'subagent', 'mentor', 'verifier', 'favorite', 'nickname'],
  safety: ['approval', 'permissions', 'sandbox', 'safety', 'security', 'docker', 'network'],
  conversation: ['memory', 'context', 'compaction', 'chat', 'rollover'],
  tools: ['tools', 'shell', 'files', 'subagents', 'skills', 'background', 'workflow'],
  'web-search': ['search', 'internet', 'browse', 'web'],
  appearance: ['theme', 'dark', 'light', 'display', 'look'],
  advanced: ['limits', 'timeout', 'logs', 'debug'],
};

/**
 * True when every word typed starts some word in the given texts, so "hang" finds "hangs" but
 * not "change", and "api key" finds "API key".
 */
export function textMatches(texts: string[], needle: string): boolean {
  const words = texts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .every((typed) => words.some((word) => word.startsWith(typed)));
}

export function matchesQuery(item: SettingItem, needle: string): boolean {
  return textMatches(
    [
      item.label,
      item.description,
      sectionLabel(item.section),
      item.group ?? '',
      item.unit ?? '',
      ...(item.keywords ?? []),
      ...(item.options ?? []).flatMap((option) => [option.label, option.hint ?? '']),
    ],
    needle,
  );
}

/** Stored → display units, without floating-point noise (0.8 × 100 → 80, not 80.00000000000001). */
export function toDisplay(value: number, factor = 1): number {
  return Number((value * factor).toPrecision(12));
}

export function fromDisplay(value: number, factor = 1): number {
  return Number((value / factor).toPrecision(12));
}
