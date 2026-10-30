import { isGpt5OrGpt6Model } from '../lib/tool-selection-policy.js';
export const PROMPT_PROFILES = [
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
export function selectPromptProfile({ model }) {
    const normalizedModel = model.trim().toLowerCase();
    return PROMPT_PROFILES.find((profile) => profile.matches({ normalizedModel }));
}
//# sourceMappingURL=prompt-profiles.js.map