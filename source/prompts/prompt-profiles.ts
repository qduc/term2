export type PromptProfile = {
  id: string;
  basePromptFile: string;
  fragmentFiles?: string[];
  matches: (options: { normalizedModel: string; liteMode: boolean; orchestratorMode?: boolean }) => boolean;
};

export const PROMPT_PROFILES: PromptProfile[] = [
  {
    id: 'lite',
    basePromptFile: 'lite.md',
    matches: ({ liteMode }) => liteMode,
  },
  {
    id: 'orchestrator',
    basePromptFile: 'orchestrator.md',
    matches: ({ orchestratorMode }) => Boolean(orchestratorMode),
  },
  {
    id: 'anthropic',
    basePromptFile: 'anthropic.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('sonnet') || normalizedModel.includes('haiku'),
  },
  {
    id: 'gpt-5.3-codex',
    basePromptFile: 'codex.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('gpt-5.3') && normalizedModel.includes('codex'),
  },
  {
    id: 'gpt-5-codex',
    basePromptFile: 'codex.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('gpt-5') && normalizedModel.includes('codex'),
  },
  {
    id: 'gpt-5.5',
    basePromptFile: 'gpt-5.5.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('gpt-5.5'),
  },
  {
    id: 'gpt-5.4-small',
    basePromptFile: 'gpt-5.4-mini.md',
    matches: ({ normalizedModel }) =>
      normalizedModel.includes('gpt-5.4') && (normalizedModel.includes('mini') || normalizedModel.includes('nano')),
  },
  {
    id: 'gpt-5.4',
    basePromptFile: 'gpt-5-modern.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('gpt-5.4'),
  },
  {
    id: 'gpt-5-modern',
    basePromptFile: 'gpt-5-modern.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('gpt-5'),
  },
  {
    id: 'kimi',
    basePromptFile: 'kimi.md',
    matches: ({ normalizedModel }) => normalizedModel.includes('kimi-k'),
  },
  {
    id: 'default',
    basePromptFile: 'simple.md',
    matches: () => true,
  },
];

export function selectPromptProfile({
  model,
  liteMode,
  orchestratorMode,
}: {
  model: string;
  liteMode: boolean;
  orchestratorMode?: boolean;
}): PromptProfile {
  const normalizedModel = model.trim().toLowerCase();
  return PROMPT_PROFILES.find((profile) => profile.matches({ normalizedModel, liteMode, orchestratorMode }))!;
}
