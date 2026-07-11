import { describe, it, expect } from 'vitest';
import {
  resolvePermissions,
  resolveLimits,
  DEFAULT_RESOLVED_PERMISSIONS,
  DEFAULT_LIMITS,
} from './permission-resolver.js';
import type { AgentPermissions, AgentLimits, ResolvedAgentPermissions } from './types.js';
import { setWorkspaceRoot } from './scope-resolver.js';

describe('resolvePermissions', () => {
  it('returns defaults when nothing is requested', () => {
    const { permissions, errors } = resolvePermissions(undefined, undefined);
    expect(permissions).toEqual(DEFAULT_RESOLVED_PERMISSIONS);
    expect(errors).toEqual([]);
  });

  it('derives canRead from read tools', () => {
    const { permissions } = resolvePermissions({ tools: ['read_file', 'grep'] });
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);
    expect(permissions.canRunShell).toBe(false);
    expect(permissions.canSearchWeb).toBe(false);
    expect(permissions.canUseNestedAgents).toBe(false);
  });

  it('derives canWrite from write tools', () => {
    const { permissions } = resolvePermissions({ tools: ['read_file', 'search_replace', 'create_file'] });
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(true);
    expect(permissions.canRunShell).toBe(false);
  });

  it('derives canRunShell from shell tool', () => {
    const { permissions } = resolvePermissions({ tools: ['shell'] });
    expect(permissions.canRunShell).toBe(true);
    expect(permissions.canRead).toBe(false);
  });

  it('derives canSearchWeb from web tools', () => {
    const { permissions } = resolvePermissions({ tools: ['web_search', 'web_fetch'] });
    expect(permissions.canSearchWeb).toBe(true);
  });

  it('derives canUseNestedAgents from nested tools', () => {
    const { permissions } = resolvePermissions({ tools: ['run_subagent'] });
    expect(permissions.canUseNestedAgents).toBe(true);
  });

  it('derives canUseNestedAgents from agents.create', () => {
    const { permissions } = resolvePermissions({
      tools: ['read_file'],
      agents: { create: true },
    });
    expect(permissions.canUseNestedAgents).toBe(true);
  });

  it('derives canRead from filesystem.read (even empty)', () => {
    const { permissions } = resolvePermissions({ filesystem: { read: [] } });
    expect(permissions.canRead).toBe(true);
  });

  it('derives canWrite from filesystem.write (even empty)', () => {
    const { permissions } = resolvePermissions({ filesystem: { write: [] } });
    expect(permissions.canWrite).toBe(true);
  });

  it('derives canSearchWeb from network.hosts (even empty)', () => {
    const { permissions } = resolvePermissions({ network: { hosts: [] } });
    expect(permissions.canSearchWeb).toBe(true);
  });

  it('resolves valid filesystem.read scopes without errors', () => {
    const { permissions, filesystemScope, errors } = resolvePermissions({
      tools: ['read_file'],
      filesystem: { read: ['src/**'] },
    });
    expect(permissions.canRead).toBe(true);
    expect(errors).toEqual([]);
    expect(filesystemScope).toBeDefined();
    expect(filesystemScope!.read).toEqual(['src/**']);
  });

  it('resolves valid filesystem.write scopes without errors', () => {
    const { filesystemScope, errors } = resolvePermissions({
      tools: ['search_replace'],
      filesystem: { write: ['src/**'] },
    });
    expect(errors).toEqual([]);
    expect(filesystemScope).toBeDefined();
    expect(filesystemScope!.write).toEqual(['src/**']);
  });

  it('resolves valid network.hosts scopes without errors', () => {
    const { networkScope, errors } = resolvePermissions({
      tools: ['web_search'],
      network: { hosts: ['api.example.com'] },
    });
    expect(errors).toEqual([]);
    expect(networkScope).toEqual(['api.example.com']);
  });

  it('rejects invalid filesystem scope patterns', () => {
    const { errors } = resolvePermissions({
      filesystem: { read: ['/etc/passwd'] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid_scope_pattern');
    expect(errors[0].field).toBe('filesystem.read');
  });

  it('rejects agents.allowedModels', () => {
    const { errors } = resolvePermissions({
      tools: ['run_subagent'],
      agents: { create: true, allowedModels: [{ provider: 'openai', model: 'gpt-4o' }] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('agents.allowedModels');
  });

  it('accumulates mixed scope errors (invalid patterns + unsupported features)', () => {
    const { errors } = resolvePermissions({
      filesystem: { read: ['/etc/passwd'], write: ['../outside'] },
      network: { hosts: ['not a host!'] },
      agents: { allowedModels: [{ provider: 'openai', model: 'gpt-4o' }] },
    });
    expect(errors).toHaveLength(4);
    // filesystem invalid patterns + network invalid + agents.allowedModels
  });

  it('intersects with parent: parent denies what child requests', () => {
    const parent: AgentPermissions = { tools: ['read_file'] };
    const requested: AgentPermissions = { tools: ['read_file', 'search_replace'] };
    const { permissions } = resolvePermissions(requested, parent);
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);
  });

  it('child cannot widen authority beyond parent', () => {
    const parent: AgentPermissions = { tools: ['read_file'] };
    const requested: AgentPermissions = {
      tools: ['read_file', 'search_replace', 'shell', 'web_search', 'run_subagent'],
    };
    const { permissions } = resolvePermissions(requested, parent);
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);
    expect(permissions.canRunShell).toBe(false);
    expect(permissions.canSearchWeb).toBe(false);
    expect(permissions.canUseNestedAgents).toBe(false);
  });

  it('explicit agents.create: false denies nested agents even when tools list includes run_subagent', () => {
    const perms: AgentPermissions = {
      tools: ['run_subagent', 'read_file'],
      agents: { create: false },
    };
    const { permissions } = resolvePermissions(perms);
    expect(permissions.canUseNestedAgents).toBe(false);
  });

  it('explicit agents.create: false blocks even when parent allows nested agents', () => {
    const parent: AgentPermissions = { agents: { create: true } };
    const child: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: false },
    };
    const { permissions } = resolvePermissions(child, parent);
    expect(permissions.canUseNestedAgents).toBe(false);
  });

  it('agents.create: false without nested tool listing still denies nested agents', () => {
    const { permissions } = resolvePermissions({
      tools: ['read_file'],
      agents: { create: false },
    });
    expect(permissions.canUseNestedAgents).toBe(false);
  });

  it('agents.create: true is still required alongside tool listing', () => {
    // create: true enables canUseNestedAgents even without explicit tool listing
    const { permissions } = resolvePermissions({
      tools: ['read_file'],
      agents: { create: true },
    });
    expect(permissions.canUseNestedAgents).toBe(true);
  });

  it('defaults to parent authority when child requests nothing', () => {
    const parent: AgentPermissions = {
      tools: ['read_file', 'search_replace', 'shell'],
    };
    const { permissions } = resolvePermissions(undefined, parent);
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(true);
    expect(permissions.canRunShell).toBe(true);
  });

  it('partial child request restricts parent authority', () => {
    const parent: AgentPermissions = {
      tools: ['read_file', 'search_replace', 'shell'],
    };
    const requested: AgentPermissions = { tools: ['read_file'] };
    const { permissions } = resolvePermissions(requested, parent);
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);
    expect(permissions.canRunShell).toBe(false);
  });

  // ── agents.maxDepth ───────────────────────────────────────────

  it('resolves agents.maxDepth from child', () => {
    const { agentsMaxDepth } = resolvePermissions({
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 3 },
    });
    expect(agentsMaxDepth).toBe(3);
  });

  it('resolves agents.maxDepth from parent', () => {
    const parent: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 2 },
    };
    const { agentsMaxDepth } = resolvePermissions(undefined, parent);
    expect(agentsMaxDepth).toBe(2);
  });

  it('clamps child agents.maxDepth to parent', () => {
    const parent: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 2 },
    };
    const child: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 5 },
    };
    const { agentsMaxDepth } = resolvePermissions(child, parent);
    expect(agentsMaxDepth).toBe(2);
  });

  it('uses more restrictive child agents.maxDepth when lower than parent', () => {
    const parent: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 5 },
    };
    const child: AgentPermissions = {
      tools: ['run_subagent'],
      agents: { create: true, maxDepth: 1 },
    };
    const { agentsMaxDepth } = resolvePermissions(child, parent);
    expect(agentsMaxDepth).toBe(1);
  });

  it('returns undefined agentsMaxDepth when neither child nor parent specifies it', () => {
    const { agentsMaxDepth } = resolvePermissions({
      tools: ['run_subagent'],
      agents: { create: true },
    });
    expect(agentsMaxDepth).toBeUndefined();
  });

  it('agents.maxDepth is preserved even when create is false (the depth still needs resolution for limits)', () => {
    // Even if create is false (preventing nested agents), maxDepth should still
    // be resolved so it can intersect with limits.maxDepth and parent authority.
    const { agentsMaxDepth } = resolvePermissions({
      tools: ['read_file'],
      agents: { create: false, maxDepth: 3 },
    });
    expect(agentsMaxDepth).toBe(3);
  });
});

describe('resolveLimits', () => {
  it('returns defaults when nothing is requested', () => {
    const result = resolveLimits(undefined, undefined);
    expect(result.maxTurns).toBe(20);
    expect(result.maxTokens).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it('applies requested limits when no parent', () => {
    const result = resolveLimits({ maxTurns: 5, timeoutMs: 30_000 }, undefined);
    expect(result.maxTurns).toBe(5);
    expect(result.timeoutMs).toBe(30_000);
  });

  it('clamps maxTurns to parent', () => {
    const parent: AgentLimits = { maxTurns: 10 };
    const requested: AgentLimits = { maxTurns: 50 };
    const result = resolveLimits(requested, parent);
    expect(result.maxTurns).toBe(10);
  });

  it('uses smaller maxTurns when child is more restrictive', () => {
    const parent: AgentLimits = { maxTurns: 20 };
    const requested: AgentLimits = { maxTurns: 15 };
    const result = resolveLimits(requested, parent);
    expect(result.maxTurns).toBe(15);
  });

  it('clamps all limit fields to parent', () => {
    const parent: AgentLimits = {
      maxTurns: 10,
      maxTokens: 100_000,
      maxCost: 5,
      timeoutMs: 60_000,
      maxChildren: 3,
      maxDepth: 2,
      maxConcurrency: 2,
    };
    const requested: AgentLimits = {
      maxTurns: 100,
      maxTokens: 200_000,
      maxCost: 10,
      timeoutMs: 120_000,
      maxChildren: 5,
      maxDepth: 5,
      maxConcurrency: 5,
    };
    const result = resolveLimits(requested, parent);
    expect(result.maxTurns).toBe(10);
    expect(result.maxTokens).toBe(100_000);
    expect(result.maxCost).toBe(5);
    expect(result.timeoutMs).toBe(60_000);
    expect(result.maxChildren).toBe(3);
    expect(result.maxDepth).toBe(2);
    expect(result.maxConcurrency).toBe(2);
  });

  it('uses parent when child requests no limits', () => {
    const parent: AgentLimits = { maxTurns: 15 };
    const result = resolveLimits(undefined, parent);
    expect(result.maxTurns).toBe(15);
  });

  it('partial child request only overrides specified fields', () => {
    const parent: AgentLimits = { maxTurns: 20, maxDepth: 3 };
    const requested: AgentLimits = { maxTurns: 5 };
    const result = resolveLimits(requested, parent);
    expect(result.maxTurns).toBe(5);
    expect(result.maxDepth).toBe(3);
  });
});
