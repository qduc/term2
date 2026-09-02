import { describe, expect, it } from 'vitest';
import { getProfileLabel } from './labels.js';

describe('getProfileLabel', () => {
  it.each([
    ['builtin:standard', 'standard'],
    ['builtin:lite', 'lite'],
    ['builtin:plan', 'plan'],
    ['builtin:mentor', 'mentor'],
    ['builtin:orchestrator', 'orchestrator'],
  ])('maps %s to %s', (profileId, label) => {
    expect(getProfileLabel(profileId)).toBe(label);
  });

  it('uses standard as the display fallback for unknown profile IDs', () => {
    expect(getProfileLabel('user:custom')).toBe('standard');
  });
});
