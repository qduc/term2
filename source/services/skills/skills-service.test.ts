import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillsService } from './skills-service.js';
import type { ILoggingService } from '../service-interfaces.js';

function createMockLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: ILoggingService = {
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: (msg) => errors.push(msg),
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
  };
  return { logger, warnings, errors };
}

const TEMP_TEST_DIR = path.join(process.cwd(), 'temp-skills-test');
const mockHome = path.join(TEMP_TEST_DIR, 'mock-home');
const mockProject = path.join(TEMP_TEST_DIR, 'mock-project');

let originalHomedir: () => string;

beforeAll(() => {
  originalHomedir = os.homedir;
  Object.defineProperty(os, 'homedir', {
    value: () => mockHome,
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  Object.defineProperty(os, 'homedir', {
    value: originalHomedir,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  if (fs.existsSync(TEMP_TEST_DIR)) {
    fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_TEST_DIR, { recursive: true });
  fs.mkdirSync(mockHome, { recursive: true });
  fs.mkdirSync(mockProject, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEMP_TEST_DIR)) {
    fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
  }
});

it.sequential('SkillsService parses correct YAML frontmatter and strips body', () => {
  const { logger } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdContent = `---
name: test-skill
description: A mock skill for testing
disable-model-invocation: false
---
# Test Skill Body
This is the markdown body.
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const skills = service.getAvailableSkills();
  expect(skills.length).toBe(1);
  expect(skills[0]?.name).toBe('test-skill');
  expect(skills[0]?.description).toBe('A mock skill for testing');
  expect(skills[0]?.disableModelInvocation).toBe(false);
  expect(skills[0]?.body).toBe('# Test Skill Body\nThis is the markdown body.');
});

it.sequential('SkillsService handles lenient validation - derives missing name from parent directory', () => {
  const { logger, warnings } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'parent-name-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdContent = `---
description: Missing name property in frontmatter
---
# Test Body
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const skills = service.getAvailableSkills();
  expect(skills.length).toBe(1);
  expect(skills[0]?.name).toBe('parent-name-skill');
  expect(warnings.some((w) => w.includes('is missing a name. Deriving from parent directory'))).toBe(true);
});

it.sequential('SkillsService skips skill with missing description', () => {
  const { logger, errors } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'invalid-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdContent = `---
name: invalid-skill
---
# Test Body
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const skills = service.getAvailableSkills();
  expect(skills.length).toBe(0);
  expect(errors.some((e) => e.includes('is missing a description. Skipping.'))).toBe(true);
});

it.sequential('SkillsService handles unquoted colons and quotes in frontmatter values', () => {
  const { logger } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'colon-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdContent = `---
name: "colon-skill"
description: Use this skill when: handling colon tests
---
# Test Body
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const skills = service.getAvailableSkills();
  expect(skills.length).toBe(1);
  expect(skills[0]?.name).toBe('colon-skill');
  expect(skills[0]?.description).toBe('Use this skill when: handling colon tests');
});

it.sequential('SkillsService project-level skills override user-level skills', () => {
  const { logger, warnings } = createMockLogger();

  // User-level skill
  const userSkillDir = path.join(mockHome, '.agents', 'skills', 'overlap-skill');
  fs.mkdirSync(userSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSkillDir, 'SKILL.md'),
    `---
name: overlap-skill
description: User level description
---
User Body`,
  );

  // Project-level skill
  const projectSkillDir = path.join(mockProject, '.agents', 'skills', 'overlap-skill');
  fs.mkdirSync(projectSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkillDir, 'SKILL.md'),
    `---
name: overlap-skill
description: Project level description
---
Project Body`,
  );

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const skills = service.getAvailableSkills();
  expect(skills.length).toBe(1);
  expect(skills[0]?.description).toBe('Project level description');
  expect(skills[0]?.body).toBe('Project Body');
  expect(warnings.some((w) => w.includes('overrides user-level'))).toBe(true);
});

it.sequential('SkillsService filter/disable model invocation', () => {
  const { logger } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'disabled-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdContent = `---
name: disabled-skill
description: This skill is disabled for model
disable-model-invocation: true
---
# Test Body
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  expect(service.getAvailableSkills().length).toBe(1);
  expect(service.getAvailableSkillsForModel().length).toBe(0);
  expect(service.getSkillCatalog()).toBe('');
});

it.sequential('SkillsService generates catalog XML correctly', () => {
  const { logger } = createMockLogger();
  const skillDir = path.join(mockProject, '.agents', 'skills', 'catalog-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: catalog-skill
description: Catalog description
---
Body`,
  );

  const service = new SkillsService(logger, mockProject);
  service.discoverSkills();

  const catalog = service.getSkillCatalog();
  expect(catalog.includes('<available_skills>')).toBe(true);
  expect(catalog.includes('<name>catalog-skill</name>')).toBe(true);
  expect(catalog.includes('<description>Catalog description</description>')).toBe(true);
  expect(catalog.includes(`<location>${path.join(skillDir, 'SKILL.md')}</location>`)).toBe(true);
});
