import { useCallback, useEffect, useMemo, useState } from 'react';
import { SETTING_KEYS, SENSITIVE_SETTINGS, type SettingsService } from '../services/settings-service.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import { scoreSubsequence } from '../utils/subsequence-filter.js';

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
  { id: 'modes', label: 'Modes' },
  { id: 'approvals', label: 'Safety & Approvals' },
  { id: 'shell', label: 'Shell Execution' },
  { id: 'search', label: 'Search & Web' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'uiLogging', label: 'UI & Logging' },
  { id: 'advanced', label: 'Advanced' },
];

const SETTING_DESCRIPTIONS: Record<string, string> = {
  [SETTING_KEYS.AGENT_MODEL]: 'The AI model to use (e.g. gpt-4, claude-3-opus)',
  [SETTING_KEYS.AGENT_REASONING_EFFORT]: 'Reasoning effort (none|minimal|low|medium|high|xhigh|default)',
  [SETTING_KEYS.AGENT_TEMPERATURE]: 'Model temperature (0–2, controls randomness)',
  [SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER]: 'Use OpenAI Flex Service Tier to reduce costs (true|false, OpenAI only)',
  [SETTING_KEYS.AGENT_MENTOR_MODEL]: 'Mentor model to use (optional, enables ask_mentor tool)',
  [SETTING_KEYS.AGENT_MENTOR_PROVIDER]: 'Provider to use for mentor model (openai, openrouter, etc.)',
  [SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT]:
    'Reasoning effort for the mentor model (none|minimal|low|medium|high|xhigh|default)',
  // agent.provider is hidden from UI - it can only be changed via model menu
  [SETTING_KEYS.AGENT_MAX_TURNS]: 'Maximum conversation turns',
  [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]: 'Number of retry attempts for failed requests',
  [SETTING_KEYS.SHELL_TIMEOUT]: 'Shell command timeout in milliseconds',
  [SETTING_KEYS.SHELL_MAX_OUTPUT_LINES]: 'Maximum lines of shell output to capture',
  [SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS]: 'Maximum characters of shell output to capture',
  [SETTING_KEYS.UI_HISTORY_SIZE]: 'Number of history items to keep',
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
  [SETTING_KEYS.WEB_SEARCH_PROVIDER]: 'Web search provider (tavily, exa)',
  [SETTING_KEYS.APP_SEARCH_VIA_SHELL]:
    'Use shell commands (ripgrep/find) for codebase search instead of built-in tools (true|false)',
  [SETTING_KEYS.SHELL_USE_RTK_COMPRESSION]:
    'Use RTK (third-party) to compress shell command output; term2 downloads it automatically (true|false)',
};

/**
 * Settings that should be hidden from the UI (not for security, but for UX/workflow)
 * - agent.provider: Can only be changed at the start of a new conversation via model menu
 * - agent.autoApproveProvider: Controlled via model/provider selection workflows, hide from the general settings list
 */
const HIDDEN_SETTINGS = new Set<string>([
  SETTING_KEYS.AGENT_PROVIDER,
  SETTING_KEYS.AGENT_AUTO_APPROVE_PROVIDER,
  SETTING_KEYS.AGENT_MENTOR_PROVIDER,
  SETTING_KEYS.TOOLS_EDIT_HEALING_PROVIDER,
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

const MAX_RESULTS = 10;

const COMMON_SETTINGS: string[] = [
  SETTING_KEYS.AGENT_MODEL,
  SETTING_KEYS.AGENT_REASONING_EFFORT,
  SETTING_KEYS.AGENT_TEMPERATURE,
];

export function getSettingCategory(key: string): SettingsCategory {
  if (
    key === SETTING_KEYS.AGENT_MODEL ||
    key === SETTING_KEYS.AGENT_REASONING_EFFORT ||
    key === SETTING_KEYS.AGENT_TEMPERATURE ||
    key === SETTING_KEYS.AGENT_MENTOR_MODEL ||
    key === SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT ||
    key === SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER
  ) {
    return SETTINGS_CATEGORIES[0]!;
  }

  if (
    key === SETTING_KEYS.APP_PLAN_MODE ||
    key === SETTING_KEYS.APP_ORCHESTRATOR_MODE ||
    key === SETTING_KEYS.APP_MENTOR_MODE ||
    key === SETTING_KEYS.APP_LITE_MODE
  ) {
    return SETTINGS_CATEGORIES[1]!;
  }

  if (key === SETTING_KEYS.SHELL_AUTO_APPROVE_MODE || key === SETTING_KEYS.AGENT_AUTO_APPROVE_MODEL) {
    return SETTINGS_CATEGORIES[2]!;
  }

  if (
    key === SETTING_KEYS.SHELL_TIMEOUT ||
    key === SETTING_KEYS.SHELL_MAX_OUTPUT_LINES ||
    key === SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS ||
    key === SETTING_KEYS.SHELL_USE_RTK_COMPRESSION
  ) {
    return SETTINGS_CATEGORIES[3]!;
  }

  if (key === SETTING_KEYS.WEB_SEARCH_PROVIDER || key === SETTING_KEYS.APP_SEARCH_VIA_SHELL) {
    return SETTINGS_CATEGORIES[4]!;
  }

  if (key.toLowerCase().includes('subagent')) {
    return SETTINGS_CATEGORIES[5]!;
  }

  if (
    key === SETTING_KEYS.UI_HISTORY_SIZE ||
    key === SETTING_KEYS.UI_PASTE_THRESHOLD ||
    key === SETTING_KEYS.LOGGING_LOG_LEVEL ||
    key === SETTING_KEYS.LOGGING_DISABLE
  ) {
    return SETTINGS_CATEGORIES[6]!;
  }

  return SETTINGS_CATEGORIES[7]!;
}

function categoryRank(key: string): number {
  const category = getSettingCategory(key);
  const index = SETTINGS_CATEGORIES.findIndex((item) => item.id === category.id);
  return index === -1 ? SETTINGS_CATEGORIES.length : index;
}

function sortSettings(a: SettingCompletionItem, b: SettingCompletionItem): number {
  const aCommonIndex = COMMON_SETTINGS.indexOf(a.key);
  const bCommonIndex = COMMON_SETTINGS.indexOf(b.key);
  const aIsCommon = aCommonIndex !== -1;
  const bIsCommon = bCommonIndex !== -1;

  if (aIsCommon && bIsCommon) return aCommonIndex - bCommonIndex;
  if (aIsCommon) return -1;
  if (bIsCommon) return 1;

  const aRank = categoryRank(a.key);
  const bRank = categoryRank(b.key);
  if (aRank !== bRank) return aRank - bRank;
  return a.key.localeCompare(b.key);
}

/**
 * Get the set of sensitive setting keys that should not appear in the UI
 */
function getSensitiveSettingKeysSet(): Set<string> {
  return new Set(Object.values(SENSITIVE_SETTINGS));
}

/**
 * Get the current value of a setting for display in the menu
 */
function getCurrentSettingValue(settingsService: SettingsService, key: string): string | number | boolean | undefined {
  try {
    const value = settingsService.get(key);
    // Format the value for display
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return value;
  } catch {
    return undefined;
  }
}

// Pure functions exported for testing
export function buildSettingsList(
  settingKeys: Record<string, string>,
  descriptions: Record<string, string>,
  excludeSensitive: boolean = true,
  getCurrentValue?: (key: string) => string | number | boolean | undefined,
): SettingCompletionItem[] {
  const sensitiveKeys = excludeSensitive ? getSensitiveSettingKeysSet() : new Set<string>();

  return Object.values(settingKeys)
    .filter((key) => !sensitiveKeys.has(key) && !HIDDEN_SETTINGS.has(key))
    .map((key) => ({
      key,
      description: descriptions[key] || '',
      currentValue: getCurrentValue?.(key),
    }))
    .sort(sortSettings);
}

export function filterSettingsByQuery(
  settings: SettingCompletionItem[],
  query: string,
  maxResults: number = 10,
): SettingCompletionItem[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return settings.slice(0, maxResults);
  }

  return settings
    .map((item) => {
      const keyScore = scoreSubsequence(trimmed, item.key);
      const hasDescriptionSubstring = item.description
        ? item.description.toLowerCase().includes(trimmed.toLowerCase())
        : false;
      const descriptionScore =
        item.description && hasDescriptionSubstring ? scoreSubsequence(trimmed, item.description) : -Infinity;

      const weightedKey = keyScore === -Infinity ? -Infinity : keyScore * 3;
      const weightedDescription = descriptionScore === -Infinity ? -Infinity : descriptionScore;

      const score = Math.max(weightedKey, weightedDescription);
      return { item, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ item }) => item);
}

export function filterSettingsByCategory<T extends { key: string }>(settings: T[], categoryId: string): T[] {
  return settings.filter((item) => getSettingCategory(item.key).id === categoryId);
}

export function clampIndex(currentIndex: number, arrayLength: number): number {
  if (arrayLength === 0) {
    return 0;
  }
  return Math.max(0, Math.min(currentIndex, arrayLength - 1));
}

export const useSettingsCompletion = (settingsService: SettingsService) => {
  const { mode, setMode, input, cursorOffset, triggerIndex, setTriggerIndex } = useInputContext();

  const isOpen = mode === 'settings_completion';

  // Derive query from input + triggerIndex
  const query = useMemo(() => {
    if (!isOpen || triggerIndex === null) return '';
    // triggerIndex is the end of "/settings " prefix
    if (triggerIndex > input.length) return '';
    const end = Math.min(cursorOffset, input.length);
    return input.slice(triggerIndex, end);
  }, [isOpen, triggerIndex, input, cursorOffset]);

  const [settingsVersion, setSettingsVersion] = useState(0);

  // Refresh the list whenever a setting changes so currentValue stays accurate
  useEffect(() => {
    const unsubscribe = settingsService.onChange(() => {
      setSettingsVersion((prev) => prev + 1);
    });
    return unsubscribe;
  }, [settingsService]);

  const allSettings = useMemo(() => {
    return buildSettingsList(SETTING_KEYS, SETTING_DESCRIPTIONS, true, (key: string) =>
      getCurrentSettingValue(settingsService, key),
    );
  }, [settingsVersion, settingsService]);

  const categories = useMemo(() => {
    const presentCategoryIds = new Set(allSettings.map((item) => getSettingCategory(item.key).id));
    return SETTINGS_CATEGORIES.filter((category) => presentCategoryIds.has(category.id));
  }, [allSettings]);

  const [activeCategoryId, setActiveCategoryId] = useState(SETTINGS_CATEGORIES[0]!.id);

  const resolvedActiveCategoryId = useMemo(() => {
    if (categories.some((category) => category.id === activeCategoryId)) {
      return activeCategoryId;
    }
    return categories[0]?.id ?? activeCategoryId;
  }, [activeCategoryId, categories]);

  const isSearchingAll = query.trim().length > 0;

  const filteredEntries = useMemo(() => {
    const candidateSettings = isSearchingAll
      ? allSettings
      : filterSettingsByCategory(allSettings, resolvedActiveCategoryId);
    return filterSettingsByQuery(candidateSettings, query, candidateSettings.length);
  }, [allSettings, isSearchingAll, query, resolvedActiveCategoryId]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredEntries);
  const [scrollOffset, setScrollOffset] = useState(0);

  const [targetKey, setTargetKey] = useState<string | null>(null);

  useEffect(() => {
    setScrollOffset(0);
  }, [query]);

  const switchCategory = useCallback(
    (direction: 'next' | 'prev' = 'next') => {
      if (categories.length === 0) return;

      const currentIndex = Math.max(
        0,
        categories.findIndex((category) => category.id === resolvedActiveCategoryId),
      );
      const delta = direction === 'next' ? 1 : -1;
      const nextIndex = (currentIndex + delta + categories.length) % categories.length;
      const nextCategory = categories[nextIndex];
      if (!nextCategory) return;

      setActiveCategoryId(nextCategory.id);
      setSelectedIndex(0);
      setScrollOffset(0);
    },
    [categories, resolvedActiveCategoryId, setSelectedIndex],
  );

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + MAX_RESULTS) {
      setScrollOffset(selectedIndex - MAX_RESULTS + 1);
    }
  }, [selectedIndex, scrollOffset]);

  // Effect to select a target key once it appears in filteredEntries
  useEffect(() => {
    if (targetKey && filteredEntries.length > 0) {
      const index = filteredEntries.findIndex((item) => item.key === targetKey);
      if (index !== -1) {
        setSelectedIndex(index);
        setTargetKey(null);
      }
    }
  }, [filteredEntries, targetKey]);

  const open = useCallback(
    (startIndex: number, initialSelectionKey?: string) => {
      // If already in settings mode, do not reset selection.
      if (mode === 'settings_completion') return;
      setMode('settings_completion');
      setTriggerIndex(startIndex);
      if (initialSelectionKey) {
        setActiveCategoryId(getSettingCategory(initialSelectionKey).id);
        setTargetKey(initialSelectionKey);
      } else {
        setSelectedIndex(0);
      }
      setScrollOffset(0);
    },
    [mode, setMode, setTriggerIndex],
  );

  const close = useCallback(() => {
    if (mode === 'settings_completion') {
      setMode('text');
      setTriggerIndex(null);
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  }, [mode, setMode, setTriggerIndex]);

  return {
    isOpen,
    triggerIndex,
    query,
    filteredEntries,
    selectedIndex,
    scrollOffset,
    isSearchingAll,
    categories,
    activeCategoryId: resolvedActiveCategoryId,
    open,
    close,
    // updateQuery,
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    moveLeft: () => switchCategory('prev'),
    moveRight: () => switchCategory('next'),
    switchCategory,
    getSelectedItem,
  };
};
