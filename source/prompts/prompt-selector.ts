import path from 'path';
import { selectPromptProfile } from './prompt-profiles.js';

type PromptSelectorOptions = {
  basePromptDir: string;
  model: string;
  liteMode: boolean;
  orchestratorMode?: boolean;
};

export function getPromptPath({ basePromptDir, model, liteMode, orchestratorMode }: PromptSelectorOptions): string {
  const profile = selectPromptProfile({ model, liteMode, orchestratorMode });
  return path.join(basePromptDir, profile.basePromptFile);
}
