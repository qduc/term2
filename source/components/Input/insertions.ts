import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import type { SettingCompletionItem } from '../../hooks/use-settings-completion.js';
import type { SettingValueSuggestion } from '../../hooks/use-settings-value-completion.js';
import type { ModelInfo } from '../../services/model-service.js';
import { SETTINGS_TRIGGER, SETTINGS_RESET_TRIGGER, AUTO_APPROVE_TRIGGER } from './triggers.js';

export type Insertion = { nextValue: string; nextCursor: number };

export const computePathInsertion = (args: {
  selection: PathCompletionItem | undefined;
  triggerIndex: number | null;
  value: string;
  cursorOffset: number;
  appendTrailingSpace: boolean;
}): Insertion | null => {
  const { selection, triggerIndex, value, cursorOffset, appendTrailingSpace } = args;
  if (!selection || triggerIndex === null) return null;
  const safeCursor = Math.min(cursorOffset, value.length);
  const before = value.slice(0, triggerIndex);
  const after = value.slice(safeCursor);
  const displayPath = selection.type === 'directory' ? `${selection.path}/` : selection.path;
  const suffix = appendTrailingSpace ? ' ' : '';
  const nextValue = `${before}${displayPath}${suffix}${after}`;
  const nextCursor = before.length + displayPath.length + suffix.length;
  return { nextValue, nextCursor };
};

export const computeSettingInsertion = (args: {
  selection: SettingCompletionItem | undefined;
  value: string;
}): Insertion | null => {
  const { selection, value } = args;
  if (!selection) return null;
  const isReset = value.startsWith(SETTINGS_RESET_TRIGGER);
  const prefix = isReset ? SETTINGS_RESET_TRIGGER : SETTINGS_TRIGGER;
  if (!value.startsWith(prefix)) return null;
  const nextValue = prefix + selection.key + ' ';
  return { nextValue, nextCursor: nextValue.length };
};

export const computeSettingValueInsertion = (args: {
  suggestion: SettingValueSuggestion | undefined;
  settingKey: string | null;
  triggerIndex: number | null;
  value: string;
  cursorOffset: number;
}): Insertion | null => {
  const { suggestion, settingKey, triggerIndex, value, cursorOffset } = args;
  if (!suggestion || !settingKey || triggerIndex === null) return null;
  const startsWithKnownTrigger = value.startsWith(SETTINGS_TRIGGER) || value.startsWith(AUTO_APPROVE_TRIGGER);
  if (!startsWithKnownTrigger) return null;
  const safeCursor = Math.min(cursorOffset, value.length);
  const before = value.slice(0, triggerIndex);
  const after = value.slice(safeCursor);
  const nextValue = `${before}${suggestion.value}${after}`;
  const nextCursor = before.length + suggestion.value.length;
  return { nextValue, nextCursor };
};

export const computeModelInsertion = (args: {
  selection: ModelInfo | undefined;
  triggerIndex: number | null;
  provider: string | null | undefined;
  value: string;
  appendTrailingSpace: boolean;
}): Insertion | null => {
  const { selection, triggerIndex, provider, value, appendTrailingSpace } = args;
  if (!selection || triggerIndex === null) return null;
  const before = value.slice(0, triggerIndex);
  // Use the current provider state instead of selection.provider to avoid stale data when
  // the user presses Enter immediately after toggling providers.
  const currentProvider = provider || 'openai';
  const insertion = `${selection.id} --provider=${currentProvider}`;
  const nextValue = `${before}${insertion}${appendTrailingSpace ? ' ' : ''}`;
  return { nextValue, nextCursor: nextValue.length };
};
