import { describe, it, expect } from 'vitest';
import { adaptLegacyRole, adaptLegacyDefinition } from './legacy-adapter.js';
import { resolveAgent } from './agent-resolver.js';
import type { ISettingsService, ILoggingService } from '../service-interfaces.js';
import type { AgentConfig, AgentPermissions, AgentLimits, ResolvedAgentPermissions } from './types.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import type { SubagentDefinition } from '../subagents/types.js';

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

describe('AgentRuntime integration: legacy roles resolve through boundary', () => {
  it('explorer role adapts and round-trips through resolveAgent', () => {
    // 1. Adapt legacy explorer role
    const legacyResolved = adaptLegacyRole('explorer', settings());

    // 2. Convert back to SubagentDefinition
    const legacyDef = adaptLegacyDefinition(legacyResolved);

    // 3. Verify the definition can drive execution
    expect(legacyDef.role).toBe('Explorer');
    expect(legacyDef.canRead).toBe(true);
    expect(legacyDef.canWrite).toBe(false);
    expect(legacyDef.canSearchWeb).toBe(false);
    // explorer has shell (read-only wrapped by tool policy)
    expect(legacyDef.canRunShell).toBe(true);
  });

  it('worker role adapts with full write + shell authority', () => {
    const resolved = adaptLegacyRole('worker', settings());
    const legacyDef = adaptLegacyDefinition(resolved);

    expect(legacyDef.role).toBe('Worker');
    expect(legacyDef.canRead).toBe(true);
    expect(legacyDef.canWrite).toBe(true);
    expect(legacyDef.canRunShell).toBe(true);
    expect(legacyDef.canSearchWeb).toBe(false);
  });

  it('researcher role adapts with web search, no shell/write', () => {
    const resolved = adaptLegacyRole('researcher', settings());
    const legacyDef = adaptLegacyDefinition(resolved);

    expect(legacyDef.canRead).toBe(true);
    expect(legacyDef.canWrite).toBe(false);
    expect(legacyDef.canRunShell).toBe(false);
    expect(legacyDef.canSearchWeb).toBe(true);
  });

  it('mentor role adapts with no authority', () => {
    const resolved = adaptLegacyRole('mentor', settings());
    const legacyDef = adaptLegacyDefinition(resolved);

    expect(legacyDef.canRead).toBe(false);
    expect(legacyDef.canWrite).toBe(false);
    expect(legacyDef.canRunShell).toBe(false);
    expect(legacyDef.canSearchWeb).toBe(false);
  });

  it('custom AgentConfig with tools and permissions resolves correctly', () => {
    const config: AgentConfig = {
      instructions: 'Test agent',
      name: 'custom',
      tools: ['read_file', 'grep', 'shell'],
      permissions: { tools: ['read_file', 'grep', 'shell'] },
    };

    const resolved = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
    });

    // Tools that match permissions are resolved
    expect(resolved.tools).toContain('read_file');
    expect(resolved.tools).toContain('grep');
    expect(resolved.tools).toContain('shell');
    // Unknown tools produce errors
    expect(resolved.resolutionErrors.filter((e) => e.code === 'unknown_tool')).toEqual([]);
  });

  it('tool resolution fails for tools denied by parent permission intersection', () => {
    const parentPerms: AgentPermissions = { tools: ['read_file'] };

    const config: AgentConfig = {
      instructions: 'Read-only agent',
      name: 'reader',
      tools: ['read_file', 'search_replace'],
      permissions: { tools: ['read_file', 'search_replace'] },
    };

    const resolved = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      parentPermissions: parentPerms,
    });

    // search_replace requires canWrite, parent only grants read
    expect(resolved.tools).toEqual(['read_file']);
    expect(resolved.resolutionErrors).toHaveLength(1);
    expect(resolved.resolutionErrors[0]).toMatchObject({
      code: 'permission_denied',
    });
    expect(resolved.resolutionErrors[0].message).toContain('search_replace');
  });

  it('unknown tools produce typed validation failure in resolutionErrors', () => {
    const config: AgentConfig = {
      instructions: 'Agent',
      tools: ['read_file', 'nonexistent_tool_xyz'],
      permissions: { tools: ['read_file', 'nonexistent_tool_xyz'] },
    };

    const resolved = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
    });

    expect(resolved.tools).toEqual(['read_file']);
    expect(resolved.resolutionErrors).toHaveLength(1);
    expect(resolved.resolutionErrors[0]).toMatchObject({
      code: 'unknown_tool',
    });
    expect(resolved.resolutionErrors[0].message).toContain('nonexistent_tool_xyz');
  });

  it('permissions are intersected with parent for nested agents', () => {
    const parentPerms: AgentPermissions = {
      tools: ['read_file'],
    };

    const config: AgentConfig = {
      instructions: 'Nested agent',
      tools: ['read_file', 'shell', 'search_replace'],
      permissions: { tools: ['read_file', 'shell', 'search_replace'] },
    };

    const resolved = resolveAgent(config, {
      settings: settings(),
      logger: logger(),
      parentPermissions: parentPerms,
    });

    // Only read_file survives (parent only grants read)
    expect(resolved.tools).toEqual(['read_file']);
    expect(resolved.permissions.canRead).toBe(true);
    expect(resolved.permissions.canWrite).toBe(false);
    expect(resolved.permissions.canRunShell).toBe(false);
  });
});

describe('adaptLegacyDefinition round-trip fidelity', () => {
  it('preserves all fields needed for execution', () => {
    const resolved: ResolvedAgentDefinition = {
      name: 'worker',
      instructions: 'Be precise.',
      model: { provider: 'anthropic', model: 'claude-sonnet' },
      permissions: {
        canRead: true,
        canWrite: true,
        canRunShell: false,
        canSearchWeb: true,
        canUseNestedAgents: false,
      },
      limits: { maxTurns: 15 },
      tools: ['read_file', 'web_search'],
      skillInstructions: 'Skill: TDD\nWrite tests first.',
      resolutionErrors: [],
    };

    const legacy = adaptLegacyDefinition(resolved);

    // The legacy definition faithfully represents the original resolved agent
    expect(legacy.instructions).toBe('Be precise.');
    expect(legacy.model).toBe('claude-sonnet');
    expect(legacy.provider).toBe('anthropic');
    expect(legacy.canRead).toBe(true);
    expect(legacy.canWrite).toBe(true);
    expect(legacy.canRunShell).toBe(false);
    expect(legacy.canSearchWeb).toBe(true);
    expect(legacy.maxTurns).toBe(15);
  });

  it('custom resolved agent adapts to a legacy definition that ExecutionSubagentRunner can consume', () => {
    const resolved: ResolvedAgentDefinition = {
      name: 'custom-reader',
      instructions: 'Read files and report.',
      model: { provider: 'openai', model: 'gpt-4o-mini' },
      permissions: {
        canRead: true,
        canWrite: false,
        canRunShell: false,
        canSearchWeb: false,
        canUseNestedAgents: false,
      },
      limits: { maxTurns: 10 },
      tools: ['read_file', 'grep'],
      skillInstructions: '',
      resolutionErrors: [],
    };

    const legacy = adaptLegacyDefinition(resolved);

    // The legacy definition is directly consumable by ExecutionSubagentRunner
    expect(legacy.role).toBe('custom-reader');
    expect(legacy.name).toBe('custom-reader');
    expect(legacy.instructions).toBe('Read files and report.');
    expect(legacy.canRead).toBe(true);
    expect(legacy.canWrite).toBe(false);
    expect(legacy.canRunShell).toBe(false);
    expect(legacy.canSearchWeb).toBe(false);
    expect(legacy.maxTurns).toBe(10);
    expect(legacy.model).toBe('gpt-4o-mini');
    expect(legacy.provider).toBe('openai');
    expect(legacy.reasoningEffort).toBe('default');
  });

  it('adaptLegacyDefinition maps new limits shape to legacy maxTurns', () => {
    const resolved: ResolvedAgentDefinition = {
      name: 'agent',
      instructions: 'test',
      model: { provider: 'openai', model: 'gpt-4o' },
      permissions: {
        canRead: true,
        canWrite: false,
        canRunShell: false,
        canSearchWeb: false,
        canUseNestedAgents: false,
      },
      limits: { maxTurns: 25, timeoutMs: 30_000 },
      tools: [],
      skillInstructions: '',
      resolutionErrors: [],
    };

    const legacy = adaptLegacyDefinition(resolved);
    expect(legacy.maxTurns).toBe(25);
  });
});
