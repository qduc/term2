import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPromptSpec } from './prompt-constructor.js';
import { resolveProfile } from '../services/profiles/index.js';

const standard = resolveProfile('builtin:standard');

describe('unified main-agent GPT prompt', () => {
  it.each([
    'gpt-5.2',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-6-luna-codex',
  ])('selects one base without GPT-only fragments for %s', (model) => {
    const spec = buildPromptSpec({ model, profile: standard });
    expect(spec.basePromptFile).toBe('gpt.md');
    expect(spec.fragmentFiles).not.toContain('fragments/gpt-6.md');
    expect(spec.fragmentFiles).not.toContain('fragments/skill-instruction-conflicts.md');
  });

  it.each(['gpt-4o', 'glm-5.3-flash', 'deepseek-flash', 'unknown-model'])(
    'keeps the simpler generic base for %s',
    (model) => {
      const spec = buildPromptSpec({ model, profile: standard });
      expect(spec.basePromptFile).toBe('simple_v4.md');
      expect(spec.fragmentFiles).toContain('approval-model.md');
    },
  );

  it('keeps the action, approval, verification, and skill-conflict rules in the base', () => {
    const text = readFileSync(join(import.meta.dirname, 'gpt.md'), 'utf8');
    expect(text).toContain('Default to action');
    expect(text).toContain('approval layer');
    expect(text).toContain('Run the checks appropriate to the change');
    expect(text).toContain('Explicit user instructions override conflicting skill instructions');
    expect(buildPromptSpec({ model: 'gpt-6-luna', profile: standard }).fragmentFiles).toContain('approval-model.md');
  });

  it('leaves non-GPT and lite profile routing unchanged', () => {
    expect(buildPromptSpec({ model: 'claude-sonnet-4', profile: standard }).basePromptFile).toBe('anthropic.md');
    expect(buildPromptSpec({ model: 'kimi-k2', profile: standard }).basePromptFile).toBe('kimi.md');
    const lite = buildPromptSpec({ model: 'gpt-6-luna', profile: resolveProfile('builtin:lite') });
    expect(lite.basePromptContent).toBeDefined();
    expect(lite.fragmentFiles).toEqual([]);
  });
});
