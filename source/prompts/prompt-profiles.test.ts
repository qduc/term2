import fs from 'fs';
import path from 'path';
import { it, expect } from 'vitest';
import { PROMPT_PROFILES, selectPromptProfile } from './prompt-profiles.js';

const PROMPTS_DIR = import.meta.dirname;

it('every prompt profile points at a base prompt file that exists on disk', () => {
  const missing = PROMPT_PROFILES.filter(
    (profile) => !fs.existsSync(path.join(PROMPTS_DIR, profile.basePromptFile)),
  ).map((profile) => `${profile.id} -> ${profile.basePromptFile}`);

  expect(missing).toEqual([]);
});

it('selectPromptProfile resolves a profile for any model string', () => {
  for (const model of ['gpt-5.6', 'gpt-5.5', 'claude-opus-5', 'kimi-k2.5', 'some-unknown-model', '']) {
    expect(selectPromptProfile({ model, liteMode: false }).basePromptFile).toBeTruthy();
  }
});
