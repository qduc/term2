import fs from 'fs';
import path from 'path';
import { it, expect } from 'vitest';
import { PROMPT_PROFILES, selectPromptProfile } from './prompt-profiles.js';

const PROMPTS_DIR = import.meta.dirname;

it('every prompt profile points at base and fragment files that exist on disk', () => {
  const missing = PROMPT_PROFILES.flatMap((profile) =>
    [profile.basePromptFile, ...(profile.fragmentFiles ?? [])]
      .filter((file) => !fs.existsSync(path.join(PROMPTS_DIR, file)))
      .map((file) => `${profile.id} -> ${file}`),
  );

  expect(missing).toEqual([]);
});

it('selectPromptProfile resolves a profile for any model string', () => {
  for (const model of ['gpt-5.6', 'gpt-5.5', 'claude-opus-5', 'kimi-k2.5', 'some-unknown-model', '']) {
    expect(selectPromptProfile({ model, liteMode: false }).basePromptFile).toBeTruthy();
  }
});
