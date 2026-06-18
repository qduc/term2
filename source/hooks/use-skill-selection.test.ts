import { it, expect } from 'vitest';
import type { SkillInfo } from '../services/skills/skills-service.js';

const createMockSkill = (name: string, desc: string): SkillInfo => ({
  name,
  description: desc,
  location: `/path/to/${name}/SKILL.md`,
  isProjectLevel: false,
  body: `# ${name}\nBody content.`,
  rawContent: `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nBody content.`,
});

const MOCK_SKILLS: SkillInfo[] = [
  createMockSkill('codebase-design', 'Design deep modules'),
  createMockSkill('diagnosing-bugs', 'Debug efficiently'),
  createMockSkill('tdd', 'Test-driven development'),
  createMockSkill('grilling', 'Interview the user about a plan'),
];

// Since useSkillSelection requires React context (useInputContext), we test
// the pure filtering logic by extracting the filter behavior.
// The hook's filtering logic is: if query is non-empty, filter skills by name
// or description containing the query (case-insensitive).

const filterSkills = (skills: SkillInfo[], query: string): SkillInfo[] => {
  if (!query) return skills;
  const lowerQuery = query.toLowerCase();
  return skills.filter(
    (s) => s.name.toLowerCase().includes(lowerQuery) || s.description.toLowerCase().includes(lowerQuery),
  );
};

it('filterSkills - empty query returns all skills', () => {
  const result = filterSkills(MOCK_SKILLS, '');
  expect(result.length).toBe(4);
  expect(result).toEqual(MOCK_SKILLS);
});

it('filterSkills - matches by name (case insensitive)', () => {
  const result = filterSkills(MOCK_SKILLS, 'TDD');
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe('tdd');
});

it('filterSkills - matches by description', () => {
  const result = filterSkills(MOCK_SKILLS, 'deep modules');
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe('codebase-design');
});

it('filterSkills - partial match works', () => {
  const result = filterSkills(MOCK_SKILLS, 'bug');
  expect(result.length).toBe(1);
  expect(result[0]!.name).toBe('diagnosing-bugs');
});

it('filterSkills - no match returns empty array', () => {
  const result = filterSkills(MOCK_SKILLS, 'nonexistent');
  expect(result.length).toBe(0);
});

it('filterSkills - empty skills array', () => {
  const result = filterSkills([], 'test');
  expect(result.length).toBe(0);
});

it('filterSkills - empty skills array with empty query', () => {
  const result = filterSkills([], '');
  expect(result.length).toBe(0);
});

it('filterSkills - query matches multiple skills', () => {
  const skills = [
    createMockSkill('skill-a', 'common word here'),
    createMockSkill('skill-b', 'also has common'),
    createMockSkill('skill-c', 'something else'),
  ];
  const result = filterSkills(skills, 'common');
  expect(result.length).toBe(2);
  expect(result.map((s) => s.name)).toEqual(['skill-a', 'skill-b']);
});
