import { it, expect } from 'vitest';
import { createSkillsSlashCommand } from '../commands/skills-command.js';
import type { SkillsService, SkillInfo } from '../services/skills/skills-service.js';

const createMockSkill = (name: string, body: string): SkillInfo => ({
  name,
  description: `Description for ${name}`,
  location: `/path/to/${name}/SKILL.md`,
  isProjectLevel: false,
  body,
  rawContent: `---\nname: ${name}\ndescription: Description for ${name}\n---\n${body}`,
});

const MOCK_SKILLS: SkillInfo[] = [
  createMockSkill('codebase-design', '# Codebase Design\nDesign deep modules.'),
  createMockSkill('diagnosing-bugs', '# Diagnosing Bugs\nDebug efficiently.'),
  createMockSkill('tdd', '# TDD\nTest-driven development.'),
  createMockSkill('disabled-skill', '# Disabled\nThis skill is disabled.'),
];

function createHarness() {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];
  const inputs: string[] = [];
  const command = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (message) => messages.push(message),
    replaceInput: (input) => inputs.push(input),
  });

  return { command, selectedSkills, messages, inputs };
}

it('createSkillsSlashCommand returns a command with correct metadata', () => {
  const { command: cmd } = createHarness();

  expect(cmd.name).toBe('skills');
  expect(cmd.description).toBe('Activate a skill for the next request');
  expect(cmd.expectsArgs).toBe(true);
  expect(cmd.completion).toEqual({ type: 'skills', trigger: '/skills ' });
});

it.each([
  {
    title: 'valid skill name announces activation',
    args: 'codebase-design',
    result: true,
    selected: 'codebase-design',
    message: 'Skill "codebase-design" activated. Type your request (or press Esc to cancel).',
  },
  {
    title: 'unknown skill name shows an error',
    args: 'nonexistent',
    result: true,
    selected: undefined,
    message: 'Unknown skill: "nonexistent"',
  },
  {
    title: 'empty args browse available skills',
    args: '',
    result: false,
    selected: undefined,
    message: undefined,
    input: '/skills ',
  },
  {
    title: 'matches skill names case-insensitively',
    args: 'CODEBASE-DESIGN',
    result: true,
    selected: 'codebase-design',
    message: undefined,
  },
  {
    title: 'normalizes surrounding whitespace',
    args: '  codebase-design  ',
    result: true,
    selected: 'codebase-design',
    message: undefined,
  },
])('action $title', ({ args, result, selected, message, input }) => {
  const { command, selectedSkills, messages, inputs } = createHarness();

  expect(command.action(args)).toBe(result);
  expect(selectedSkills[0]?.name).toBe(selected);
  if (message) {
    expect(messages[0]).toContain(message);
  } else if (selected === undefined) {
    expect(messages).toEqual([]);
  }
  expect(inputs).toEqual(input ? [input] : []);
});
