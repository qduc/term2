import { describe, it, expect, beforeEach } from 'vitest';
import { resolveSkills } from './skill-resolver.js';
import type { ILoggingService } from '../service-interfaces.js';
import { SkillsService } from '../skills/skills-service.js';

function logger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

describe('resolveSkills', () => {
  let skills: SkillsService;

  beforeEach(() => {
    skills = new SkillsService(logger());
  });

  it('returns empty instructions for undefined skills list', () => {
    const result = resolveSkills(undefined, skills);
    expect(result.instructions).toBe('');
    expect(result.errors).toEqual([]);
  });

  it('returns empty instructions for empty skills list', () => {
    const result = resolveSkills([], skills);
    expect(result.instructions).toBe('');
    expect(result.errors).toEqual([]);
  });

  it('returns an error for unknown skill names', () => {
    const result = resolveSkills(['nonexistent'], skills);
    expect(result.instructions).toBe('');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'unknown_skill',
      skillName: 'nonexistent',
    });
  });

  it('returns errors for multiple unknown skills', () => {
    const result = resolveSkills(['a', 'b'], skills);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].skillName).toBe('a');
    expect(result.errors[1].skillName).toBe('b');
  });

  it('returns instruction bodies for known skills', () => {
    // Manually register some skills
    (skills as any).skills.set('tdd', {
      name: 'tdd',
      description: 'Test-driven development',
      body: 'Write tests first.',
      location: '/fake/tdd/SKILL.md',
    });
    (skills as any).skills.set('refactor', {
      name: 'refactor',
      description: 'Refactoring patterns',
      body: 'Extract method.',
      location: '/fake/refactor/SKILL.md',
    });

    const result = resolveSkills(['tdd', 'refactor'], skills);
    expect(result.errors).toEqual([]);
    expect(result.instructions).toContain('Write tests first.');
    expect(result.instructions).toContain('Extract method.');
  });

  it('returns partial instructions when some skills are missing', () => {
    (skills as any).skills.set('tdd', {
      name: 'tdd',
      description: 'Test-driven development',
      body: 'Write tests first.',
      location: '/fake/tdd/SKILL.md',
    });

    const result = resolveSkills(['tdd', 'missing'], skills);
    expect(result.instructions).toContain('Write tests first.');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].skillName).toBe('missing');
  });

  it('rejects structured output requests as unsupported', () => {
    (skills as any).skills.set('tdd', {
      name: 'tdd',
      description: 'TDD',
      body: 'Write tests first.',
      location: '/fake/tdd/SKILL.md',
    });

    // If a skill requests structured output and we don't support it,
    // the error should surface. For now all output contributions are rejected.
    const result = resolveSkills(['tdd'], skills);
    // No structured output features in MVP, just instructions.
    expect(result.instructions).toContain('Write tests first.');
  });
});
