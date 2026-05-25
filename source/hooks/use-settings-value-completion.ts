import { useCallback, useEffect, useMemo, useState } from 'react';
import { scoreSubsequence } from '../utils/subsequence-filter.js';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings-service.js';
import { useSelection } from './use-selection.js';

export type SettingValueSuggestion = {
  value: string;
  description?: string;
};

const MAX_RESULTS = 10;

const NUMBER_SETTING_KEYS = new Set([
  'agent.temperature',
  'agent.maxTurns',
  'agent.retryAttempts',
  'shell.timeout',
  'shell.maxOutputLines',
  'shell.maxOutputChars',
  'ui.historySize',
  'ssh.port',
]);

const REASONING_EFFORT_VALUE_SUGGESTIONS: SettingValueSuggestion[] = [
  { value: 'none', description: 'No reasoning (fastest)' },
  { value: 'minimal', description: 'Very low reasoning' },
  { value: 'low', description: 'Low reasoning' },
  { value: 'medium', description: 'Balanced' },
  { value: 'high', description: 'High reasoning' },
  { value: 'xhigh', description: 'Maximum reasoning' },
  { value: 'default', description: 'Model default' },
];

const PROVIDER_VALUE_SUGGESTIONS: SettingValueSuggestion[] = [
  { value: 'openai', description: 'OpenAI official API' },
  { value: 'openrouter', description: 'OpenRouter.ai' },
  { value: 'openai-compatible', description: 'Local models/Ollama' },
  { value: 'anthropic', description: 'Anthropic Claude' },
  { value: 'google', description: 'Google Gemini' },
  { value: 'codex', description: 'ChatGPT Codex (OAuth)' },
];

// A small, curated set of value suggestions for common settings.
// This is intentionally conservative: it's better to suggest a few helpful values
// than to pretend we can enumerate every possible value.
const VALUE_SUGGESTIONS_BY_KEY: Record<string, SettingValueSuggestion[]> = {
  'agent.reasoningEffort': REASONING_EFFORT_VALUE_SUGGESTIONS,
  'agent.mentorReasoningEffort': REASONING_EFFORT_VALUE_SUGGESTIONS,
  'agent.subagentExplorerReasoningEffort': REASONING_EFFORT_VALUE_SUGGESTIONS,
  'agent.subagentWorkerReasoningEffort': REASONING_EFFORT_VALUE_SUGGESTIONS,
  'agent.subagentResearcherReasoningEffort': REASONING_EFFORT_VALUE_SUGGESTIONS,
  'agent.mentorProvider': PROVIDER_VALUE_SUGGESTIONS,
  'agent.subagentExplorerProvider': PROVIDER_VALUE_SUGGESTIONS,
  'agent.subagentWorkerProvider': PROVIDER_VALUE_SUGGESTIONS,
  'agent.subagentResearcherProvider': PROVIDER_VALUE_SUGGESTIONS,
  'agent.autoApproveProvider': PROVIDER_VALUE_SUGGESTIONS,
  'tools.editHealingProvider': PROVIDER_VALUE_SUGGESTIONS,
  'logging.logLevel': [{ value: 'debug' }, { value: 'info' }, { value: 'warn' }, { value: 'error' }],
  'logging.suppressConsoleOutput': [{ value: 'true' }, { value: 'false' }],
  'tools.enableEditHealing': [{ value: 'true' }, { value: 'false' }],
  'agent.useFlexServiceTier': [
    { value: 'true', description: 'Enable Flex Service Tier (lower cost)' },
    { value: 'false', description: 'Use standard service tier' },
  ],
  'app.mentorMode': [{ value: 'true' }, { value: 'false' }],
  'app.liteMode': [{ value: 'true' }, { value: 'false' }],
  'app.planMode': [{ value: 'true' }, { value: 'false' }],
  'agent.provider': PROVIDER_VALUE_SUGGESTIONS,
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
  'agent.maxTurns': [{ value: '10' }, { value: '20' }, { value: '50' }],
  'agent.retryAttempts': [{ value: '1' }, { value: '2' }, { value: '3' }],
  'ssh.port': [{ value: '22', description: 'Default SSH port' }],
  'shell.autoApproveMode': [
    { value: 'off', description: 'Disabled' },
    { value: 'advisory', description: 'LLM provides safety analysis' },
    { value: 'auto', description: 'Full auto-approval (CAUTION)' },
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

// Pure functions exported for testing
export function buildSettingValueSuggestions(key: string): SettingValueSuggestion[] {
  // If we don't know the key, return empty and let users type freely.
  return VALUE_SUGGESTIONS_BY_KEY[key] ?? [];
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
  if (key && NUMBER_SETTING_KEYS.has(key) && trimmed && !results.some((r) => r.value === trimmed)) {
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

  return results.slice(0, maxResults);
}

export const useSettingsValueCompletion = (
  settingsService: SettingsService,
  options?: { onReset?: (key: string) => void },
) => {
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const isOpen = mode === 'settings_value_completion';

  const [settingKey, setSettingKey] = useState<string | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);

  // Recompute current setting value suggestions when settings change.
  // (Useful if we later want to add "current" or dynamic suggestions.)
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [settingsService]);

  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, triggerIndex, input, cursorOffset]);

  const allSuggestions = useMemo(() => {
    if (!settingKey) return [];
    // settingsVersion is used to allow refresh when values change.
    void settingsVersion;
    return buildSettingValueSuggestions(settingKey);
  }, [settingKey, settingsVersion]);

  const filteredEntries = useMemo(() => {
    return filterSettingValueSuggestionsByQuery(allSuggestions, query, MAX_RESULTS, settingKey ?? undefined);
  }, [allSuggestions, query, settingKey]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);

  const open = useCallback(
    (key: string, valueStartIndex: number) => {
      if (mode === 'settings_value_completion' && settingKey === key) {
        return;
      }
      setSettingKey(key);
      setMode('settings_value_completion');
      setTriggerIndex(valueStartIndex);

      // Get current value from settingsService and find it in suggestions
      try {
        const currentValue = settingsService.get(key);
        const suggestions = buildSettingValueSuggestions(key);
        const currentIndex =
          currentValue !== undefined ? suggestions.findIndex((s) => s.value === String(currentValue)) : -1;

        // If current value found in suggestions, select it; otherwise default to 0
        setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
      } catch {
        // If there's an error getting the value, default to first item
        setSelectedIndex(0);
      }
    },
    [mode, setMode, setTriggerIndex, settingKey, settingsService],
  );

  const close = useCallback(() => {
    if (mode === 'settings_value_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setSettingKey(null);
    }
  }, [mode, setMode, setTriggerIndex]);

  const resetCurrentSetting = useCallback(() => {
    if (settingKey) {
      const key = settingKey;
      settingsService.reset(key);
      close();
      options?.onReset?.(key);
    } else {
      close();
    }
  }, [settingKey, settingsService, close, options]);

  const isNumericSettings = useMemo(() => {
    return settingKey ? NUMBER_SETTING_KEYS.has(settingKey) : false;
  }, [settingKey]);

  return {
    isOpen,
    triggerIndex,
    settingKey,
    query,
    filteredEntries,
    selectedIndex,
    open,
    close,
    resetCurrentSetting,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    isNumericSettings,
  };
};
