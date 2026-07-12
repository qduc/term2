import { describe, it, expect } from 'vitest';
import { adaptLegacyRole, adaptLegacyDefinition } from './legacy-adapter.js';
import type { ISettingsService } from '../service-interfaces.js';
import type { AgentConfig, ResolvedAgentDefinition } from './index.js';

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

describe('adaptLegacyRole', () => {
  it('adapts explorer role to ResolvedAgentDefinition', () => {
    const def = adaptLegacyRole('explorer', settings());
    expect(def.name).toBe('Explorer');
    expect(def.permissions.canRead).toBe(true);
    expect(def.permissions.canWrite).toBe(false);
    expect(def.permissions.canRunShell).toBe(true); // explorer has shell (read-only wrapped)
    expect(def.permissions.canSearchWeb).toBe(false);
    expect(def.permissions.canUseNestedAgents).toBe(false);
    expect(def.model.provider).toBe('openai');
    expect(def.instructions).toBeTruthy();
    // Tools are resolved later by SubagentToolFactory; legacy adapter passes empty list.
    expect(def.tools).toEqual([]);
  });

  it('adapts worker role to ResolvedAgentDefinition', () => {
    const def = adaptLegacyRole('worker', settings());
    expect(def.name).toBe('Worker');
    expect(def.permissions.canRead).toBe(true);
    expect(def.permissions.canWrite).toBe(true);
    expect(def.permissions.canRunShell).toBe(true);
    expect(def.permissions.canSearchWeb).toBe(false);
  });

  it('adapts researcher role to ResolvedAgentDefinition', () => {
    const def = adaptLegacyRole('researcher', settings());
    expect(def.name).toBe('Researcher');
    expect(def.permissions.canRead).toBe(true);
    expect(def.permissions.canWrite).toBe(false);
    expect(def.permissions.canRunShell).toBe(false);
    expect(def.permissions.canSearchWeb).toBe(true);
  });

  it('adapts mentor role to ResolvedAgentDefinition', () => {
    const def = adaptLegacyRole('mentor', settings());
    expect(def.name).toBe('Mentor');
    // Mentor has no filesystem/shell authority
    expect(def.permissions.canRead).toBe(false);
    expect(def.permissions.canWrite).toBe(false);
    expect(def.permissions.canRunShell).toBe(false);
    expect(def.permissions.canSearchWeb).toBe(false);
    expect(def.permissions.canUseNestedAgents).toBe(false);
  });

  it('adapts librarian role to ResolvedAgentDefinition', () => {
    const def = adaptLegacyRole('librarian', settings());
    expect(def.name).toBe('Memory Librarian');
    expect(def.permissions.canRead).toBe(false);
    expect(def.permissions.canWrite).toBe(false);
    expect(def.permissions.canRunShell).toBe(false);
    expect(def.permissions.canSearchWeb).toBe(false);
    expect(def.permissions.canUseNestedAgents).toBe(false);
    expect(def.instructions).toContain('memory librarian');
  });

  it('throws for unknown role', () => {
    expect(() => adaptLegacyRole('unknown_role', settings())).toThrow(/unknown subagent role/i);
  });
});

describe('adaptLegacyDefinition', () => {
  it('converts ResolvedAgentDefinition to legacy SubagentDefinition shape', () => {
    const resolved: ResolvedAgentDefinition = {
      name: 'custom-agent',
      instructions: 'do work',
      model: { provider: 'openai', model: 'gpt-4o' },
      permissions: {
        canRead: true,
        canWrite: true,
        canRunShell: false,
        canSearchWeb: false,
        canUseNestedAgents: false,
      },
      limits: { maxTurns: 10 },
      tools: ['read_file', 'search_replace'],
      skillInstructions: '',
      resolutionErrors: [],
    };

    const legacy = adaptLegacyDefinition(resolved);
    expect(legacy.role).toBe('custom-agent');
    expect(legacy.name).toBe('custom-agent');
    expect(legacy.instructions).toBe('do work');
    expect(legacy.canRead).toBe(true);
    expect(legacy.canWrite).toBe(true);
    expect(legacy.canRunShell).toBe(false);
    expect(legacy.canSearchWeb).toBe(false);
    expect(legacy.maxTurns).toBe(10);
    expect(legacy.model).toBe('gpt-4o');
    expect(legacy.provider).toBe('openai');
  });
});
