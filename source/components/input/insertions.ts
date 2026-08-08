import type { PathCompletionItem } from '../../hooks/use-path-completion.js';
import type { ModelInfo } from '../../services/model-service.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';

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

export const computeModelInsertion = (args: {
  selection: ModelInfo | undefined;
  modelId?: string;
  triggerIndex: number | null;
  provider: string | null | undefined;
  value: string;
  appendTrailingSpace: boolean;
  includeProvider?: boolean;
}): Insertion | null => {
  const { selection, modelId, triggerIndex, provider, value, appendTrailingSpace, includeProvider = true } = args;
  if (triggerIndex === null) return null;
  const resolvedModelId = modelId?.trim() || selection?.id;
  if (!resolvedModelId) return null;
  const before = value.slice(0, triggerIndex);
  // Use the current provider state instead of selection.provider to avoid stale data when
  // the user presses Enter immediately after toggling providers.
  const currentProvider = provider || 'openai';
  const insertion = includeProvider ? `${resolvedModelId} --provider=${currentProvider}` : resolvedModelId;
  const nextValue = `${before}${insertion}${appendTrailingSpace ? ' ' : ''}`;
  return { nextValue, nextCursor: nextValue.length };
};

export const computeSkillInsertion = (args: {
  selection: SkillInfo | undefined;
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
  const suffix = appendTrailingSpace && (after.length === 0 || !/^\s/.test(after)) ? ' ' : '';
  const nextValue = `${before}${selection.name}${suffix}${after}`;
  const nextCursor = before.length + selection.name.length + suffix.length;
  return { nextValue, nextCursor };
};
