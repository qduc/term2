import { it, expect } from 'vitest';
import { filterProfiles, PROFILE_OPTIONS } from './use-profile-selection.js';

it('profile options cover all built-in profiles', () => {
  expect(PROFILE_OPTIONS.map((p) => p.shortId).sort()).toEqual(
    ['lite', 'mentor', 'orchestrator', 'plan', 'standard'].sort(),
  );
  for (const option of PROFILE_OPTIONS) {
    expect(option.id).toBe(`builtin:${option.shortId}`);
  }
});

it('filterProfiles matches short id and display name case-insensitively', () => {
  expect(filterProfiles(PROFILE_OPTIONS, '')).toHaveLength(5);
  expect(filterProfiles(PROFILE_OPTIONS, 'lite').map((p) => p.shortId)).toEqual(['lite']);
  expect(filterProfiles(PROFILE_OPTIONS, 'ORCH').map((p) => p.shortId)).toEqual(['orchestrator']);
  expect(filterProfiles(PROFILE_OPTIONS, 'zzz')).toHaveLength(0);
});
