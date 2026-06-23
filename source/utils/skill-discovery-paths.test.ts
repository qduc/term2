import { it, expect } from 'vitest';
import path from 'path';
import {
  SKILL_SCOPE_DIRS,
  getProjectSkillScopes,
  getUserSkillScopes,
  getDiscoveredSkillRoots,
} from './skill-discovery-paths.js';

it('uses a single centralized skill scope list', () => {
  expect(SKILL_SCOPE_DIRS).toEqual(['.term2', '.agents', '.claude']);
});

it('builds project and user skill scope paths from the same scope list', () => {
  const base = '/workspace';
  const home = '/home/tester';

  expect(getProjectSkillScopes(base)).toEqual([
    path.join(base, '.term2', 'skills'),
    path.join(base, '.agents', 'skills'),
    path.join(base, '.claude', 'skills'),
  ]);

  expect(getUserSkillScopes(home)).toEqual([
    path.join(home, '.term2', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
  ]);

  expect(getDiscoveredSkillRoots(base, home)).toEqual([
    path.join(base, '.term2', 'skills'),
    path.join(base, '.agents', 'skills'),
    path.join(base, '.claude', 'skills'),
    path.join(home, '.term2', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
  ]);
});
