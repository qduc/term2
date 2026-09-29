import { describe, expect, it } from 'vitest';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import { parentAuthorityFromDefinition, resolveAgentSpecForChild } from './permission-boundary.js';

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

function settings(): ISettingsService {
  const values: Record<string, unknown> = {
    'agent.provider': 'openai',
    'agent.model': 'gpt-4o',
    'agent.efficientModel': 'gpt-4o-mini',
    'agent.balancedModel': 'gpt-4o',
    'agent.capableModel': 'gpt-5',
  };
  return {
    get: (key: string) => values[key] as never,
    getDynamic: (key: string) => values[key],
    set: () => {},
    setDynamic: () => {},
    setPersistent: () => {},
    setPersistentDynamic: () => {},
  };
}

function parent(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
  return {
    name: 'parent',
    instructions: 'parent',
    model: { provider: 'openai', model: 'gpt-5' },
    permissions: {
      canRead: true,
      canWrite: true,
      canRunShell: true,
      canSearchWeb: true,
      canUseNestedAgents: true,
    },
    limits: { maxTurns: 20, maxDepth: 2 },
    tools: ['read_file', 'grep', 'shell', 'apply_patch', 'search_replace', 'create_file', 'web_search', 'web_fetch'],
    skillInstructions: '',
    resolutionErrors: [],
    ...overrides,
  };
}

function resolve(spec: unknown, authority = parentAuthorityFromDefinition(parent())) {
  return resolveAgentSpecForChild(spec, { settings: settings(), logger: logger(), parent: authority });
}

describe('resolveAgentSpecForChild', () => {
  it('allows a child subset and preserves narrowed filesystem, network, and nested-agent authority', () => {
    const result = resolve({
      goal: 'Inspect the source tree',
      tools: ['read_file', 'web_search'],
      permissions: {
        tools: ['read_file', 'web_search'],
        filesystem: { read: ['src/**'] },
        network: { hosts: ['docs.example.com'] },
        agents: { create: true, maxDepth: 1 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.tools).toEqual(['read_file', 'web_search']);
    expect(result.definition.filesystemScope).toEqual({ read: ['src/**'], write: [] });
    expect(result.definition.networkScope).toEqual(['docs.example.com']);
    expect(result.definition.permissions).toMatchObject({
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: true,
      canUseNestedAgents: true,
    });
    expect(result.definition.limits.maxDepth).toBe(1);
  });

  it('rejects tools and scopes that exceed a narrower parent', () => {
    const result = resolve(
      {
        goal: 'Modify everything',
        tools: ['read_file', 'shell', 'apply_patch', 'web_fetch'],
        permissions: {
          tools: ['read_file', 'shell', 'apply_patch', 'web_fetch'],
          filesystem: { read: ['src/**'], write: ['src/**'] },
          network: { hosts: ['evil.example'] },
        },
      },
      parentAuthorityFromDefinition(
        parent({
          permissions: {
            canRead: true,
            canWrite: false,
            canRunShell: false,
            canSearchWeb: false,
            canUseNestedAgents: false,
          },
          tools: ['read_file'],
          filesystemScope: { read: ['src/**'], write: [] },
          networkScope: [],
        }),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('permission_denied');
    expect(result.errors.some((error) => error.field === 'permissions.network.hosts')).toBe(true);
  });

  it('fails closed for unsupported, omitted, and malicious fields', () => {
    expect(resolve({ tools: ['read_file'] }).ok).toBe(false);
    expect(resolve({ goal: 'x', tools: ['run_subagent'] }).ok).toBe(false);
    expect(resolve({ goal: 'x', budget: { timeoutMs: 10 } }).ok).toBe(false);
    expect(resolve({ goal: 'x', permissions: { agents: { allowedModels: [] } } }).ok).toBe(false);
    expect(resolve({ goal: 'x', unexpected: true }).ok).toBe(false);

    const scopeWithoutTool = resolve({ goal: 'x', tools: [], permissions: { filesystem: { write: ['src/**'] } } });
    expect(scopeWithoutTool.ok).toBe(true);
    if (scopeWithoutTool.ok) expect(scopeWithoutTool.definition.permissions.canWrite).toBe(false);
  });

  it('rejects an omitted effective parent authority instead of inventing defaults', () => {
    const result = resolveAgentSpecForChild(
      { goal: 'inspect', tools: [] },
      {
        settings: settings(),
        logger: logger(),
        parent: undefined as never,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('missing_parent_authority');
  });

  it.each([
    ['read-only mode', { readOnly: true }],
    ['plan mode', { planMode: true }],
  ])('rejects write authority in %s', (_name, mode) => {
    const result = resolveAgentSpecForChild(
      { goal: 'edit files', tools: ['apply_patch'], permissions: { tools: ['apply_patch'] } },
      { settings: settings(), logger: logger(), parent: parentAuthorityFromDefinition(parent()), ...mode },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.code)).toContain('permission_denied');
  });

  it('allows only an explicitly authorized worktree and rejects an unprovable one', () => {
    const authority = parentAuthorityFromDefinition(parent(), { worktreeScope: ['feature-a'] });
    expect(
      resolveAgentSpecForChild(
        { goal: 'inspect', tools: [] },
        {
          settings: settings(),
          logger: logger(),
          parent: authority,
          worktree: 'feature-a',
        },
      ).ok,
    ).toBe(true);
    const denied = resolveAgentSpecForChild(
      { goal: 'inspect', tools: [] },
      {
        settings: settings(),
        logger: logger(),
        parent: authority,
        worktree: 'feature-b',
      },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.errors[0].code).toBe('unsupported_worktree_scope');
  });
});
