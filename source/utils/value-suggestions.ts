import { scoreSubsequence } from './subsequence-filter.js';
import { resolveSettingAtPath, unwrapSchema } from '../services/settings/setting-schema-utils.js';

export type SettingValueSuggestion = {
  value: string;
  description?: string;
};

const MAX_RESULTS = 10;

// Curated suggestions for settings where the schema alone can't express them:
// - Provider fields are `z.string()`, but users benefit from knowing which providers exist.
// - Temperature / auto-approve model have opinionated presets, not enum values.
// - Some enum/boolean fields carry custom descriptions that enrich the UX.
const VALUE_SUGGESTIONS_BY_KEY: Record<string, SettingValueSuggestion[]> = {
  'agent.mentorProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'agent.subagentExplorerProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'agent.subagentWorkerProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'agent.subagentResearcherProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'agent.subagentLibrarianProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'agent.autoApproveProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'tools.editHealingProvider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
  ],
  'logging.logLevel': [{ value: 'debug' }, { value: 'info' }, { value: 'warn' }, { value: 'error' }],
  'agent.useFlexServiceTier': [
    { value: 'true', description: 'Enable Flex Service Tier (lower cost)' },
    { value: 'false', description: 'Use standard service tier' },
  ],
  'agent.provider': [
    { value: 'openai', description: 'OpenAI official API' },
    { value: 'openrouter', description: 'OpenRouter.ai' },
    { value: 'openai-compatible', description: 'Local models/Ollama' },
    { value: 'anthropic', description: 'Anthropic Claude' },
    { value: 'google', description: 'Google Gemini' },
    { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
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
  'shell.maxOutputLines': [{ value: '200' }, { value: '500' }, { value: '1000' }],
  'shell.maxOutputChars': [{ value: '20000' }, { value: '50000' }, { value: '100000' }],
  'ui.historySize': [{ value: '50' }, { value: '100' }, { value: '200' }],
  'ui.displayMode': [
    { value: 'standard', description: 'Standard output (full details)' },
    { value: 'concise', description: 'Concise output (no reasoning, one-line tool calls)' },
  ],
  'agent.maxTurns': [{ value: '10' }, { value: '20' }, { value: '50' }],
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
 * Extract enum values from a Zod schema as value-suggestion entries.
 * Returns empty array if the schema is not an enum type.
 *
 * Zod v3: def.type === 'enum', def.values is string[]
 * Zod v4: def.type === 'enum', def.entries is Record<string, string>
 */
function suggestFromEnum(schema: any): SettingValueSuggestion[] {
  if (!schema) return [];
  const def = (schema?._def ?? schema?.def) as any;
  if (def?.type !== 'enum') return [];

  // Zod v4: def.entries is Record<string, string>
  if (def.entries && typeof def.entries === 'object' && !Array.isArray(def.entries)) {
    return (Object.values(def.entries) as string[]).map((v: string) => ({ value: v }));
  }

  // Zod v3: def.values is string[]
  if (Array.isArray(def.values)) {
    return def.values.map((v: string) => ({ value: v }));
  }

  return [];
}

/**
 * Extract boolean suggestions from a Zod schema.
 * Returns empty array if the schema is not a boolean type.
 */
function suggestFromBoolean(_schema: any): SettingValueSuggestion[] {
  return [{ value: 'true' }, { value: 'false' }];
}

/**
 * Auto-generate value suggestions by introspecting the Zod schema for a setting.
 *
 * - `z.enum([...])` → one suggestion per enum value
 * - `z.boolean()` (including `.optional()`, `.default()`, `.transform()`) → true/false
 * - Other types → empty array (no auto-suggestion)
 */
function autoSuggestFromSchema(key: string): SettingValueSuggestion[] {
  const schema = resolveSettingAtPath(key);
  if (!schema) return [];
  const unwrapped = unwrapSchema(schema);
  if (!unwrapped) return [];

  const def = (unwrapped as any)._def ?? (unwrapped as any).def;
  if (!def) return [];

  const typeName = def.type ?? def.typeName;

  // Handle enum: Zod v3/v4 both use type === 'enum'
  if (typeName === 'enum') {
    return suggestFromEnum(unwrapped);
  }

  // Handle boolean: Zod v3/v4 both use type === 'boolean'
  if (typeName === 'boolean') {
    return suggestFromBoolean(unwrapped);
  }

  return [];
}

// Type guard for isNumberSetting / isStringSetting (kept for backward compat).
export function isStringSetting(key: string): boolean {
  return isSettingType(key, 'string');
}

export function isNumberSetting(key: string): boolean {
  return isSettingType(key, 'number');
}

function isSettingType(key: string, expectedType: 'number' | 'string'): boolean {
  const schema = resolveSettingAtPath(key);
  if (!schema) return false;
  const unwrapped = unwrapSchema(schema);
  if (!unwrapped) return false;
  // In Zod v4, number/string checks are on the base schema, not wrappers.
  // .int(), .positive() etc. add checks but keep the schema as ZodNumber.
  const def = (unwrapped as any)._def;
  return def?.type === expectedType;
}

/**
 * Build value suggestions for a setting key.
 *
 * Returns curated hardcoded suggestions when available, otherwise falls back to
 * auto-generated suggestions derived from the Zod schema (enum values, boolean).
 */
export function buildSettingValueSuggestions(key: string): SettingValueSuggestion[] {
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
  if (key && isSettingType(key, 'number') && trimmed && !results.some((r) => r.value === trimmed)) {
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
  if (key && isSettingType(key, 'string') && trimmed && !results.some((r) => r.value === trimmed)) {
    const hasPredefined = (VALUE_SUGGESTIONS_BY_KEY[key]?.length ?? 0) > 0;
    if (!hasPredefined) {
      results.unshift({
        value: trimmed,
        description: 'Custom value',
      });
    }
  }

  return results.slice(0, maxResults);
}
