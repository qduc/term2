import { it, expect } from 'vitest';
import { computeModelInsertion, computeSkillInsertion } from './insertions.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';
import type { ModelInfo } from '../../services/model-service.js';

const createSkill = (name: string): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `/skills/${name}/SKILL.md`,
  isProjectLevel: true,
  body: `# ${name}`,
  rawContent: `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}`,
});

const createModel = (id: string): ModelInfo => ({
  id,
  name: id,
  provider: 'openai',
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

it('computeModelInsertion keeps non-submit insertion clean without provider flag', () => {
  const result = computeModelInsertion({
    selection: createModel('gpt-5'),
    triggerIndex: '/model '.length,
    provider: 'anthropic',
    value: '/model g',
    appendTrailingSpace: true,
    includeProvider: false,
  });

  expect(result).toEqual({
    nextValue: '/model gpt-5 ',
    nextCursor: '/model gpt-5 '.length,
  });
});

it('computeModelInsertion includes provider flag for submit insertion', () => {
  const result = computeModelInsertion({
    selection: createModel('gpt-5'),
    triggerIndex: '/model '.length,
    provider: 'anthropic',
    value: '/model g',
    appendTrailingSpace: false,
    includeProvider: true,
  });

  expect(result).toEqual({
    nextValue: '/model gpt-5 --provider=anthropic',
    nextCursor: '/model gpt-5 --provider=anthropic'.length,
  });
});
