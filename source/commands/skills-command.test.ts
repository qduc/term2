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

it('createSkillsSlashCommand returns a command with correct metadata', () => {
  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: () => {},
    addSystemMessage: () => {},
    setInput: () => {},
  });

  expect(cmd.name).toBe('skills');
  expect(cmd.description).toBe('Activate a skill for the next request');
  expect(cmd.expectsArgs).toBe(true);
  expect(cmd.completion).toEqual({ type: 'skills', trigger: '/skills ' });
});

it('action with valid skill name calls onSkillSelected and addSystemMessage', () => {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];

  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (msg) => messages.push(msg),
    setInput: () => {},
  });

  const result = cmd.action('codebase-design');
  expect(result).toBe(true);
  expect(selectedSkills.length).toBe(1);
  expect(selectedSkills[0]!.name).toBe('codebase-design');
  expect(messages.length).toBe(1);
  expect(messages[0]).toBe('Skill "codebase-design" activated. Type your request (or press Esc to cancel).');
});

it('action with unknown skill name shows error message', () => {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];

  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (msg) => messages.push(msg),
    setInput: () => {},
  });

  const result = cmd.action('nonexistent');
  expect(result).toBe(true);
  expect(selectedSkills.length).toBe(0);
  expect(messages.length).toBe(1);
  expect(messages[0]).toContain('Unknown skill: "nonexistent"');
});

it('action with empty args autocompletes to /skills ', () => {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];
  const inputs: string[] = [];

  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (msg) => messages.push(msg),
    setInput: (val) => inputs.push(val),
  });

  const result = cmd.action('');
  expect(result).toBe(false);
  expect(selectedSkills.length).toBe(0);
  expect(messages.length).toBe(0);
  expect(inputs).toEqual(['/skills ']);
});

it('action matches skill name case-insensitively', () => {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];

  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (msg) => messages.push(msg),
    setInput: () => {},
  });

  const result = cmd.action('CODEBASE-DESIGN');
  expect(result).toBe(true);
  expect(selectedSkills.length).toBe(1);
  expect(selectedSkills[0]!.name).toBe('codebase-design');
});

it('action with skill name that has extra whitespace still matches', () => {
  const selectedSkills: SkillInfo[] = [];
  const messages: string[] = [];

  const cmd = createSkillsSlashCommand({
    skillsService: { getAvailableSkills: () => MOCK_SKILLS } as unknown as SkillsService,
    onSkillSelected: (skill) => selectedSkills.push(skill),
    addSystemMessage: (msg) => messages.push(msg),
    setInput: () => {},
  });

  const result = cmd.action('  codebase-design  ');
  expect(result).toBe(true);
  expect(selectedSkills.length).toBe(1);
  expect(selectedSkills[0]!.name).toBe('codebase-design');
});
