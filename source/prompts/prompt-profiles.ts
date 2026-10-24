import { isGpt5OrGpt6Model } from '../lib/tool-selection-policy.js';

export type PromptProfile = {
  id: string;
  basePromptFile: string;
  fragmentFiles?: string[];
  matches: (options: { normalizedModel: string }) => boolean;
};

export const PROMPT_PROFILES: PromptProfile[] = [
  {
    id: 'gpt',
    basePromptFile: 'gpt.md',
    matches: ({ normalizedModel }) => isGpt5OrGpt6Model(normalizedModel),
  },
  {
    id: 'anthropic',
    basePromptFile: 'anthropic.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('sonnet') || normalizedModel.includes('haiku'),
  },
  {
    id: 'kimi',
    basePromptFile: 'kimi.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('kimi-k'),
  },
  {
    id: 'default',
    basePromptFile: 'simple_v4.md',
    matches: () => true,
  },
];

export function selectPromptProfile({ model }: { model: string }): PromptProfile {
  const normalizedModel = model.trim().toLowerCase();
  return PROMPT_PROFILES.find((profile) => profile.matches({ normalizedModel }))!;
}
