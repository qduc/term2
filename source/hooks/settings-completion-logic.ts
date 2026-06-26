import { SENSITIVE_SETTINGS } from '../services/settings/settings-service.js';
import { scoreSubsequence } from '../utils/subsequence-filter.js';
import {
  CATEGORY_KEYS,
  CATEGORY_ORDER,
  COMMON_SETTINGS,
  HIDDEN_SETTINGS,
  SETTINGS_CATEGORIES,
  type SettingCompletionItem,
  type SettingsCategory,
} from './settings-completion-config.js';

function findCategoryById(id: string): SettingsCategory {
  return (
    SETTINGS_CATEGORIES.find((category) => category.id === id) || SETTINGS_CATEGORIES[SETTINGS_CATEGORIES.length - 1]!
  );
}

export function getSettingCategory(key: string): SettingsCategory {
  for (const categoryId of CATEGORY_ORDER) {
    if (CATEGORY_KEYS[categoryId].has(key)) {
      return findCategoryById(categoryId);
    }
  }

  if (key.toLowerCase().includes('subagent')) {
    return findCategoryById('subagents');
  }

  return findCategoryById('advanced');
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

function getSensitiveSettingKeysSet(): Set<string> {
  return new Set(Object.values(SENSITIVE_SETTINGS));
}

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
