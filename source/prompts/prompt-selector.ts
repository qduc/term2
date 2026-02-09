import path from 'path';

const DEFAULT_PROMPT = 'simple.md';
const ANTHROPIC_PROMPT = 'anthropic.md';
const GPT_PROMPT = 'gpt-5.md';
const CODEX_PROMPT = 'codex.md';
const LITE_PROMPT = 'lite.md';

type PromptSelectorOptions = {
  basePromptDir: string;
  model: string;
  liteMode: boolean;
};

export function getPromptPath({ basePromptDir, model, liteMode }: PromptSelectorOptions): string {
  const normalizedModel = model.trim().toLowerCase();

  // Lite mode takes precedence - minimal context for terminal assistance
  if (liteMode) {
    return path.join(basePromptDir, LITE_PROMPT);
  }

  if (normalizedModel.includes('sonnet') || normalizedModel.includes('haiku'))
    return path.join(basePromptDir, ANTHROPIC_PROMPT);
  if (normalizedModel.includes('gpt-5') && normalizedModel.includes('codex'))
    return path.join(basePromptDir, CODEX_PROMPT);
  if (normalizedModel.includes('gpt-5')) return path.join(basePromptDir, GPT_PROMPT);

  return path.join(basePromptDir, DEFAULT_PROMPT);
}
