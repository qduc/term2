import { SENSITIVE_SETTINGS } from '../services/settings/settings-service.js';
import { getSettingLabel } from '../services/settings/settings-ui-metadata.js';
import { scoreSubsequence } from '../utils/subsequence-filter.js';
import {
  CATEGORY_KEYS,
  HIDDEN_SETTINGS,
  SETTINGS_CATEGORIES,
  SETTING_SEARCH_KEYWORDS,
  type SettingCompletionItem,
  type SettingsCategory,
} from './settings-completion-config.js';

/** Browse position of every categorized key: category index, then list order. */
const CATEGORY_POSITION = new Map<string, { category: SettingsCategory; rank: number }>();
SETTINGS_CATEGORIES.forEach((category, categoryIndex) => {
  (CATEGORY_KEYS[category.id] ?? []).forEach((key, index) => {
    CATEGORY_POSITION.set(key, { category, rank: categoryIndex * 1000 + index });
  });
});

/** The browse tab a setting lives in; `undefined` for advanced settings. */
export function getSettingCategory(key: string): SettingsCategory | undefined {
  return CATEGORY_POSITION.get(key)?.category;
}

export function isAdvancedSetting(key: string): boolean {
  return !CATEGORY_POSITION.has(key);
}

function browseRank(key: string): number {
  return CATEGORY_POSITION.get(key)?.rank ?? Number.MAX_SAFE_INTEGER;
}

function getSensitiveSettingKeysSet(): Set<string> {
  return new Set(Object.values(SENSITIVE_SETTINGS));
}

export function buildSettingsList(
  settingKeys: Record<string, string>,
  descriptions: Record<string, string>,
  excludeSensitive: boolean = true,
  getCurrentValue?: (key: string) => unknown,
): SettingCompletionItem[] {
  const sensitiveKeys = excludeSensitive ? getSensitiveSettingKeysSet() : new Set<string>();

  return Object.values(settingKeys)
    .filter((key) => !sensitiveKeys.has(key) && !HIDDEN_SETTINGS.has(key))
    .map((key) => ({
      key,
      label: getSettingLabel(key),
      description: descriptions[key] || '',
      currentValue: getCurrentValue?.(key),
      isAdvanced: isAdvancedSetting(key),
    }))
    .sort((a, b) => browseRank(a.key) - browseRank(b.key) || a.label.localeCompare(b.label));
}

const WORD_SPLIT = /[^a-z0-9]+/;

/**
 * Score one query word against a setting. Whole-word and word-prefix hits in
 * the label rank highest; key, keyword, and description substrings follow.
 * Returns -Infinity when the word appears nowhere.
 */
function scoreWord(word: string, item: SettingCompletionItem): number {
  const label = item.label.toLowerCase();
  const labelWords = label.split(WORD_SPLIT);
  const keywords = (SETTING_SEARCH_KEYWORDS[item.key] ?? '').toLowerCase().split(WORD_SPLIT);
  const key = item.key.toLowerCase();
  const description = (item.description ?? '').toLowerCase();

  if (labelWords.includes(word)) return 100;
  if (labelWords.some((part) => part.startsWith(word))) return 80;
  if (keywords.includes(word)) return 70;
  if (label.includes(word)) return 60;
  if (key.includes(word)) return 50;
  if (keywords.some((part) => part.startsWith(word))) return 40;
  if (description.split(WORD_SPLIT).some((part) => part.startsWith(word))) return 20;
  return -Infinity;
}

/**
 * Filter by a free-text query. Every whitespace-separated word must match the
 * setting somewhere (label, key, search keywords, description). Only when no
 * setting matches that way does a fuzzy label/key subsequence match apply, so
 * a typo still finds something without flooding normal searches with noise.
 * Advanced settings rank after browse-tab settings of equal relevance.
 */
export function filterSettingsByQuery(
  settings: SettingCompletionItem[],
  query: string,
  maxResults: number = 10,
): SettingCompletionItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return settings.slice(0, maxResults);
  }

  const words = trimmed.split(/\s+/);
  const advancedPenalty = (item: SettingCompletionItem) => (item.isAdvanced ? 20 : 0);

  const exact = settings
    .map((item) => {
      let score = 0;
      for (const word of words) {
        const wordScore = scoreWord(word, item);
        if (wordScore === -Infinity) return { item, score: -Infinity };
        score += wordScore;
      }
      if (item.label.toLowerCase() === trimmed || item.key.toLowerCase() === trimmed) score += 1000;
      return { item, score: score - advancedPenalty(item) };
    })
    .filter(({ score }) => score !== -Infinity);

  const ranked =
    exact.length > 0
      ? exact
      : settings
          .map((item) => {
            const compact = trimmed.replace(/\s+/g, '');
            const score = Math.max(scoreSubsequence(compact, item.label), scoreSubsequence(compact, item.key));
            return { item, score: score === -Infinity ? score : score - advancedPenalty(item) };
          })
          .filter(({ score }) => score !== -Infinity);

  return ranked
    .sort((a, b) => b.score - a.score || browseRank(a.item.key) - browseRank(b.item.key))
    .slice(0, maxResults)
    .map(({ item }) => item);
}

export function filterSettingsByCategory<T extends { key: string }>(settings: T[], categoryId: string): T[] {
  return settings.filter((item) => getSettingCategory(item.key)?.id === categoryId);
}

export function clampIndex(currentIndex: number, arrayLength: number): number {
  if (arrayLength === 0) {
    return 0;
  }
  return Math.max(0, Math.min(currentIndex, arrayLength - 1));
}
