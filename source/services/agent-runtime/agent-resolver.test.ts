import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAgent } from './agent-resolver.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { SkillsService } from '../skills/skills-service.js';
import type { AgentConfig, AgentPermissions, AgentLimits } from './types.js';

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

function settings(values: Record<string, unknown> = {}): ISettingsService {
  const store: Record<string, unknown> = {
    'agent.provider': 'openai',
    'agent.model': 'gpt-4o',
    ...values,
  };
  return {
    get: <T>(key: string) => store[key] as T,
    set: () => {},
  };
}

describe('resolveAgent', () => {
  it('resolves minimal config to balanced defaults', () => {
    const config: AgentConfig = { instructions: 'You are helpful.' };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });

    expect(result.name).toBe('agent');
    expect(result.instructions).toBe('You are helpful.');
    expect(result.model).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(result.permissions.canRead).toBe(false);
    expect(result.permissions.canWrite).toBe(false);
    expect(result.permissions.canRunShell).toBe(false);
    expect(result.limits.maxTurns).toBe(20);
    expect(result.tools).toEqual([]);
    expect(result.skillInstructions).toBe('');
    expect(result.resolutionErrors).toEqual([]);
  });

  it('resolves explicit model tier', () => {
    const s = settings({
      'agent.efficientModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    const config: AgentConfig = {
      instructions: 'test',
      model: 'efficient',
    };
    const result = resolveAgent(config, { settings: s, logger: logger() });
    expect(result.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('resolves exact model policy', () => {
    const config: AgentConfig = {
      instructions: 'test',
      model: { provider: 'anthropic', model: 'claude-sonnet' },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
  });

  it('derives permissions from tools', () => {
    const config: AgentConfig = {
      instructions: 'test',
      permissions: { tools: ['read_file', 'search_replace'] },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.permissions.canRead).toBe(true);
    expect(result.permissions.canWrite).toBe(true);
    expect(result.permissions.canRunShell).toBe(false);
  });

  it('intersects child permissions with parent', () => {
    const parentPerms: AgentPermissions = { tools: ['read_file'] };
    const config: AgentConfig = {
      instructions: 'test',
      permissions: { tools: ['read_file', 'search_replace'] },
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      parentPermissions: parentPerms,
    });
    expect(result.permissions.canRead).toBe(true);
    expect(result.permissions.canWrite).toBe(false);
  });

  it('clamps limits to parent', () => {
    const parentLimits: AgentLimits = { maxTurns: 5 };
    const config: AgentConfig = {
      instructions: 'test',
      limits: { maxTurns: 100 },
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      parentLimits,
    });
    expect(result.limits.maxTurns).toBe(5);
  });

  it('resolves skills via SkillsService', () => {
    const skillsService = new SkillsService(logger());
    (skillsService as any).skills.set('tdd', {
      name: 'tdd',
      description: 'Test-driven development',
      body: 'Write tests first.',
      location: '/fake/tdd/SKILL.md',
    });

    const config: AgentConfig = {
      instructions: 'test',
      skills: ['tdd'],
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      skillsService,
    });
    expect(result.skillInstructions).toContain('Write tests first.');
  });

  it('reports unknown skill errors in resolutionErrors', () => {
    const skillsService = new SkillsService(logger());
    const config: AgentConfig = {
      instructions: 'test',
      skills: ['nonexistent'],
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      skillsService,
    });
    expect(result.resolutionErrors).toHaveLength(1);
    expect(result.resolutionErrors[0].code).toBe('unknown_skill');
  });

  it('reports relative model policy error without parent', () => {
    const config: AgentConfig = {
      instructions: 'test',
      model: { tier: 'lower' },
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      // No parent model policy
    });
    expect(result.resolutionErrors).toHaveLength(1);
    expect(result.resolutionErrors[0].code).toBe('invalid_model_policy');
    // Falls back to balanced
    expect(result.model.model).toBe('gpt-4o');
  });

  it('resolves relative model with parent', () => {
    const s = settings({
      'agent.efficientModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    const config: AgentConfig = {
      instructions: 'test',
      model: { tier: 'lower' },
    };
    const result = resolveAgent(config, {
      settings: s,
      logger: logger(),
      parentModelPolicy: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(result.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(result.resolutionErrors).toEqual([]);
  });

  it('resolves tools from config.tools with permissions.tools authorization', () => {
    const config: AgentConfig = {
      instructions: 'test',
      tools: ['read_file', 'grep'],
      permissions: { tools: ['read_file', 'grep'] },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.tools).toEqual(['read_file', 'grep']);
  });

  it('resolves fine-grained filesystem scopes without errors for valid patterns', () => {
    const config: AgentConfig = {
      instructions: 'test',
      permissions: {
        filesystem: { read: ['src/**'] },
      },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.resolutionErrors.filter((e) => e.code === 'unsupported_permission_scope')).toEqual([]);
    expect(result.filesystemScope).toBeDefined();
    expect(result.filesystemScope!.read).toEqual(['src/**']);
  });

  it('accumulates invalid_scope_pattern errors for invalid patterns', () => {
    const config: AgentConfig = {
      instructions: 'test',
      permissions: {
        filesystem: { read: ['/etc/passwd'] },
      },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.resolutionErrors).toHaveLength(1);
    expect(result.resolutionErrors[0].code).toBe('invalid_scope_pattern');
  });

  // ── config.tools / permissions.tools separation ────────────────

  it('(a) omitting config.tools yields no tools even when permissions.tools lists tools', () => {
    const config: AgentConfig = {
      instructions: 'test',
      // tools omitted
      permissions: { tools: ['read_file', 'grep', 'search_replace'] },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    // Coarse permissions are derived from permissions.tools (unchanged)
    expect(result.permissions.canRead).toBe(true);
    expect(result.permissions.canWrite).toBe(true);
    // But config.tools is omitted → no tools resolved
    expect(result.tools).toEqual([]);
  });

  it('(b) config.tools not in permissions.tools yields permission_denied', () => {
    const config: AgentConfig = {
      instructions: 'test',
      tools: ['read_file', 'search_replace'],
      permissions: { tools: ['read_file'] },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    // Only read_file is authorized
    expect(result.tools).toEqual(['read_file']);
    expect(result.resolutionErrors).toHaveLength(1);
    expect(result.resolutionErrors[0]).toMatchObject({
      code: 'permission_denied',
    });
    expect(result.resolutionErrors[0].message).toContain('search_replace');
    expect(result.resolutionErrors[0].message).toContain('not authorized');
  });

  it('(c) matching config.tools and permissions.tools resolves all tools', () => {
    const config: AgentConfig = {
      instructions: 'test',
      tools: ['read_file', 'grep', 'glob'],
      permissions: { tools: ['read_file', 'grep', 'glob'] },
    };
    const result = resolveAgent(config, { settings: settings(), logger: logger() });
    expect(result.tools).toEqual(['read_file', 'grep', 'glob']);
    expect(result.resolutionErrors).toEqual([]);
  });

  it('(d) parent permissions.tools still attenuate child authority', () => {
    const parentPerms: AgentPermissions = { tools: ['read_file', 'grep'] };
    const config: AgentConfig = {
      instructions: 'test',
      tools: ['read_file', 'search_replace'],
      permissions: { tools: ['read_file', 'search_replace', 'shell'] },
    };
    const result = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      parentPermissions: parentPerms,
    });
    // Parent coarse: only canRead (from read_file, grep)
    // Child authorized: read_file, search_replace, shell
    // Child requested: read_file, search_replace
    // search_replace passes authorization but fails coarse (parent denies canWrite)
    expect(result.tools).toEqual(['read_file']);
    expect(result.resolutionErrors).toHaveLength(1);
    expect(result.resolutionErrors[0].message).toMatch(/search_replace/);
  });
});
