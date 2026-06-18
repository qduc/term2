import { it, expect } from 'vitest';
import { computeSkillInsertion } from './insertions.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';

const createSkill = (name: string): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `/skills/${name}/SKILL.md`,
  isProjectLevel: true,
  body: `# ${name}`,
  rawContent: `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}`,
});

it('computeSkillInsertion replaces the active skill query and preserves suffix text', () => {
  const value = '/skills deep module please';
  const result = computeSkillInsertion({
    selection: createSkill('codebase-design'),
    triggerIndex: '/skills '.length,
    value,
    cursorOffset: '/skills deep module'.length,
    appendTrailingSpace: true,
  });

  expect(result).toEqual({
    nextValue: '/skills codebase-design please',
    nextCursor: '/skills codebase-design'.length,
  });
});
