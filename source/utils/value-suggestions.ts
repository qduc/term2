import { scoreSubsequence } from './subsequence-filter.js';
import {
  getSettingMetadata,
  isSecretSetting,
  isStringSetting,
  isNumberSetting,
} from '../services/settings/settings-ui-metadata.js';
import { getProvider, getProviderIds } from '../providers/index.js';
import { OAUTH_ACCOUNT_PROVIDERS } from '../providers/oauth-accounts.js';
import { KNOWN_CUSTOM_PROVIDER_TYPES } from '../services/settings/settings-schema.js';

export { isSecretSetting, isStringSetting, isNumberSetting };

export type SettingValueSuggestion = {
  value: string;
  description?: string;
};

const MAX_RESULTS = 10;

const CURATED_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  openai: 'OpenAI official API',
  openrouter: 'OpenRouter.ai',
  'openai-compatible': 'Local models/Ollama',
  anthropic: 'Anthropic Claude',
  google: 'Google Gemini',
  codex: 'ChatGPT Codex (OAuth)',
  grok: 'xAI Grok (OAuth)',
  'llama.cpp': 'Local llama.cpp server',
  opencode: 'OpenCode runtime',
};

export function isProviderSettingKey(key: string): boolean {
  return key === 'agent.provider' || key.endsWith('Provider');
}

export function buildProviderSuggestions(): SettingValueSuggestion[] {
  const providerIds = new Set<string>();

  for (const id of getProviderIds()) {
    providerIds.add(id);
  }

  for (const id of OAUTH_ACCOUNT_PROVIDERS) {
    providerIds.add(id);
  }

  for (const type of KNOWN_CUSTOM_PROVIDER_TYPES) {
    providerIds.add(type);
  }

  const preferredOrder = [
    'openai',
    'openrouter',
    'openai-compatible',
    'anthropic',
    'google',
    'codex',
    'grok',
    'llama.cpp',
    'opencode',
  ];

  const orderedIds: string[] = [];
  for (const id of preferredOrder) {
    if (providerIds.has(id)) {
      orderedIds.push(id);
      providerIds.delete(id);
    }
  }
  for (const id of providerIds) {
    orderedIds.push(id);
  }

  return orderedIds.map((id) => ({
    value: id,
    description: CURATED_PROVIDER_DESCRIPTIONS[id] ?? getProvider(id)?.label,
  }));
}

// Curated suggestions for settings where the schema alone can't express them:
// - Temperature / auto-approve model have opinionated presets, not enum values.
// - Some enum/boolean fields carry custom descriptions that enrich the UX.
const VALUE_SUGGESTIONS_BY_KEY: Record<string, SettingValueSuggestion[]> = {
  'logging.logLevel': [{ value: 'debug' }, { value: 'info' }, { value: 'warn' }, { value: 'error' }],
  'agent.useFlexServiceTier': [
    { value: 'true', description: 'Enable Flex Service Tier (lower cost)' },
    { value: 'false', description: 'Use standard service tier' },
  ],
  'agent.autoApproveModel': [
    { value: 'gpt-4o-mini', description: 'OpenAI fast model' },
    { value: 'claude-3-haiku-20240307', description: 'Anthropic fast model' },
    { value: 'gemini-1.5-flash', description: 'Google fast model' },
  ],
  'agent.temperature': [
    { value: '0', description: 'Deterministic' },
    { value: '0.2' },
    { value: '0.7' },
    { value: '1' },
    { value: '1.2' },
    { value: '2', description: 'Most random' },
  ],
  'shell.timeout': [
    { value: '60000', description: '60s' },
    { value: '120000', description: '120s' },
    { value: '300000', description: '5m' },
  ],
  'shell.backgroundTimeout': [
    { value: '600000', description: '10m' },
    { value: '1800000', description: '30m (default)' },
    { value: '3600000', description: '1h' },
  ],
  'shell.maxOutputLines': [{ value: '200' }, { value: '500' }, { value: '1000' }],
  'shell.maxOutputChars': [{ value: '20000' }, { value: '50000' }, { value: '100000' }],
  'ui.historySize': [{ value: '50' }, { value: '100' }, { value: '200' }],
  'ui.displayMode': [
    { value: 'standard', description: 'Standard output (full details)' },
    { value: 'concise', description: 'Concise output (no reasoning, one-line tool calls)' },
  ],
  'agent.maxTurns': [{ value: '10' }, { value: '20' }, { value: '50' }],
  'agent.runBudget.maxUsdMicros': [
    { value: '1000000', description: '$1' },
    { value: '5000000', description: '$5 (default)' },
    { value: '10000000', description: '$10' },
  ],
  'agent.runBudget.maxUnpricedTokens': [
    { value: '100000', description: '100k tokens' },
    { value: '500000', description: '500k tokens (default)' },
    { value: '1000000', description: '1m tokens' },
  ],
  'agent.runBudget.maxActiveTimeMs': [
    { value: '1800000', description: '30m' },
    { value: '3600000', description: '1h (default)' },
    { value: '7200000', description: '2h' },
  ],
  'agent.runBudget.warningHeadroomUsdMicros': [
    { value: '500000', description: '$0.50' },
    { value: '1000000', description: '$1 (default)' },
    { value: '2000000', description: '$2' },
  ],
  'agent.runBudget.warningHeadroomUnpricedTokens': [
    { value: '50000', description: '50k tokens' },
    { value: '100000', description: '100k tokens (default)' },
    { value: '200000', description: '200k tokens' },
  ],
  'agent.runBudget.warningHeadroomActiveTimeMs': [
    { value: '300000', description: '5m' },
    { value: '900000', description: '15m (default)' },
    { value: '1800000', description: '30m' },
  ],
  'agent.runBudget.softHeadroomUsdMicros': [
    { value: '100000', description: '$0.10' },
    { value: '250000', description: '$0.25 (default)' },
    { value: '500000', description: '$0.50' },
  ],
  'agent.runBudget.softHeadroomUnpricedTokens': [
    { value: '10000', description: '10k tokens' },
    { value: '25000', description: '25k tokens (default)' },
    { value: '50000', description: '50k tokens' },
  ],
  'agent.runBudget.softHeadroomActiveTimeMs': [
    { value: '120000', description: '2m' },
    { value: '300000', description: '5m (default)' },
    { value: '600000', description: '10m' },
  ],
  'agent.runBudget.turnBackstop': [{ value: '100' }, { value: '150', description: 'default' }, { value: '200' }],
  'agent.runBudget.extensionPercent': [
    { value: '25', description: 'quarter budget' },
    { value: '50', description: 'half budget (default)' },
    { value: '100', description: 'full budget' },
  ],
  'agent.runBudget.maxParentExtensions': [{ value: '1' }, { value: '2', description: 'default' }, { value: '3' }],
  'agent.runBudget.escalation': [
    { value: 'warn', description: 'status-bar warning only (default)' },
    { value: 'pause', description: 'hold the run for a human decision' },
    { value: 'disabled', description: 'disable budget warnings and pauses' },
  ],
  'agent.runBudget.identicalToolCallThreshold': [
    { value: '2' },
    { value: '3', description: 'default' },
    { value: '5' },
  ],
  'agent.retryAttempts': [{ value: '1' }, { value: '2' }, { value: '3' }],
  'agent.transport': [
    { value: 'websocket', description: 'WebSocket transport with response chaining' },
    { value: 'http', description: 'HTTP transport with full-history requests' },
  ],
  'ssh.port': [{ value: '22', description: 'Default SSH port' }],
  'shell.autoApproveMode': [
    { value: 'off', description: 'Disabled' },
    { value: 'advisory', description: 'LLM provides safety analysis' },
    { value: 'auto', description: 'Full auto-approval (CAUTION)' },
    { value: 'always', description: 'YOLO - allow all, no approval (DANGEROUS)' },
  ],
  'sandbox.readPolicy': [
    {
      value: 'standard',
      description: 'Sandboxed commands can read anywhere except known credential paths (~/.ssh, ~/.aws, ~/.kube, etc.)',
    },
    {
      value: 'strict',
      description:
        'Sandboxed commands can only read the workspace, temp dir, and system tooling paths (cannot read home dir, /etc, /var)',
    },
  ],
  'webSearch.provider': [
    { value: 'tavily', description: 'Tavily Search API' },
    { value: 'exa', description: 'Exa (formerly Metaphor) Search API' },
  ],
  'app.searchViaShell': [
    { value: 'auto', description: 'Auto-enable for gpt-5 models' },
    { value: 'on', description: 'Always use shell commands (ripgrep/find) for search' },
    { value: 'off', description: 'Always use built-in search tools' },
  ],
  'shell.useRtkCompression': [
    { value: 'true', description: 'Enable RTK compression (downloaded automatically if needed)' },
    { value: 'false', description: 'Use normal shell output' },
  ],
};

/**
 * Auto-generate value suggestions by introspecting the Zod schema metadata for a setting.
 *
 * - `z.enum([...])` → one suggestion per enum value
 * - `z.boolean()` → true/false
 * - Other types → empty array (no auto-suggestion)
 */
function autoSuggestFromSchema(key: string): SettingValueSuggestion[] {
  const meta = getSettingMetadata(key);
  if (!meta) return [];

  if (meta.type === 'enum' && meta.enumOptions) {
    return meta.enumOptions.map((value) => ({ value }));
  }

  if (meta.type === 'boolean') {
    return [{ value: 'true' }, { value: 'false' }];
  }

  return [];
}

/**
 * Build value suggestions for a setting key.
 *
 * Returns curated hardcoded suggestions when available, otherwise falls back to
 * auto-generated suggestions derived from the Zod schema (enum values, boolean).
 */
export function buildSettingValueSuggestions(key: string): SettingValueSuggestion[] {
  if (isProviderSettingKey(key)) {
    return buildProviderSuggestions();
  }
  // If we have curated suggestions, use them (they may include descriptions,
  // custom ordering, or non-schema data like known provider list).
  if (VALUE_SUGGESTIONS_BY_KEY[key]) {
    return VALUE_SUGGESTIONS_BY_KEY[key];
  }
  // Otherwise derive from schema: enum values → suggestions, boolean → true/false.
  return autoSuggestFromSchema(key);
}

export function filterSettingValueSuggestionsByQuery(
  suggestions: SettingValueSuggestion[],
  query: string,
  maxResults: number = MAX_RESULTS,
  key?: string,
): SettingValueSuggestion[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return suggestions.slice(0, maxResults);
  }

  const scoredResults = suggestions
    .map((item) => {
      const valueScore = scoreSubsequence(trimmed, item.value);
      const descriptionScore = item.description ? scoreSubsequence(trimmed, item.description) : -Infinity;

      // Reward value match more than description match
      const weightedValue = valueScore === -Infinity ? -Infinity : valueScore * 2;
      const weightedDescription = descriptionScore === -Infinity ? -Infinity : descriptionScore;

      const score = Math.max(weightedValue, weightedDescription);
      return { item, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .sort((a, b) => b.score - a.score);

  const results = scoredResults.map((r) => r.item);

  // For number settings, if the query itself is a valid number and not already
  // in the results as an exact match, add it as a "Custom value" option.
  if (key && isNumberSetting(key) && trimmed && !results.some((r) => r.value === trimmed)) {
    const numValue = Number(trimmed);
    if (!isNaN(numValue)) {
      // Add to the START of results so it's the default choice
      // when typing a custom value.
      results.unshift({
        value: trimmed,
        description: 'Custom value',
      });
    }
  }

  // For string settings without predefined suggestions, allow free-form input.
  if (key && isStringSetting(key) && trimmed && !results.some((r) => r.value === trimmed)) {
    const hasPredefined = isProviderSettingKey(key) || (VALUE_SUGGESTIONS_BY_KEY[key]?.length ?? 0) > 0;
    if (!hasPredefined) {
      results.unshift({
        value: trimmed,
        description: 'Custom value',
      });
    }
  }

  return results.slice(0, maxResults);
}
