import { describe, it, expect } from 'vitest';
import { resolveTools } from './tools-resolver.js';
import type { ResolvedAgentPermissions } from './types.js';

describe('resolveTools', () => {
  it('returns empty resolved list for undefined tools', () => {
    const result = resolveTools(undefined, {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty resolved list for empty tools', () => {
    const result = resolveTools([], {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('resolves known tools with matching permissions', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['read_file', 'search_replace'], perms);
    expect(result.resolved).toEqual(['read_file', 'search_replace']);
    expect(result.errors).toEqual([]);
  });

  it('rejects unknown tools with validation failure', () => {
    const result = resolveTools(['nonexistent_tool'], {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'unknown_tool',
      toolName: 'nonexistent_tool',
    });
  });

  it('rejects tools whose required permission is not granted', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['read_file', 'search_replace'], perms);
    expect(result.resolved).toEqual(['read_file']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'permission_denied',
      toolName: 'search_replace',
    });
  });

  it('rejects shell when canRunShell is false', () => {
    const perms: ResolvedAgentPermissions = {
      canRunShell: false,
      canRead: false,
      canWrite: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['shell'], perms);
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('permission_denied');
  });

  it('resolves shell when canRunShell is true', () => {
    const result = resolveTools(['shell'], {
      canRunShell: true,
      canRead: false,
      canWrite: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    });
    expect(result.resolved).toEqual(['shell']);
    expect(result.errors).toEqual([]);
  });

  it('rejects web_search when canSearchWeb is false', () => {
    const result = resolveTools(['web_search'], {
      canSearchWeb: false,
      canRead: false,
      canWrite: false,
      canRunShell: false,
      canUseNestedAgents: false,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('resolves multiple valid tools while rejecting invalid ones', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['read_file', 'search_replace', 'shell', 'unknown_tool'], perms);
    expect(result.resolved).toEqual(['read_file', 'search_replace']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].toolName).toBe('shell');
    expect(result.errors[1].toolName).toBe('unknown_tool');
  });

  it('requires canUseNestedAgents for run_subagent', () => {
    const result = resolveTools(['run_subagent'], {
      canUseNestedAgents: false,
      canRead: false,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
    });
    expect(result.resolved).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('permission_denied');
  });

  // ── Authorization gate (permissions.tools) ──────────────────────

  it('rejects tools not in the authorized list (permissions.tools)', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['read_file', 'search_replace'], perms, ['read_file']);
    expect(result.resolved).toEqual(['read_file']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'permission_denied',
      toolName: 'search_replace',
    });
    expect(result.errors[0].message).toContain('not authorized');
  });

  it('resolves tools when all requested are in the authorized list', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    const result = resolveTools(['read_file', 'grep', 'search_replace'], perms, [
      'read_file',
      'grep',
      'search_replace',
      'shell',
    ]);
    expect(result.resolved).toEqual(['read_file', 'grep', 'search_replace']);
    expect(result.errors).toEqual([]);
  });

  it('returns empty when requested is empty even if authorized has tools', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: true,
      canSearchWeb: true,
      canUseNestedAgents: true,
    };
    const result = resolveTools([], perms, ['read_file', 'shell']);
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty when requested is undefined even if authorized has tools', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: true,
      canRunShell: true,
      canSearchWeb: true,
      canUseNestedAgents: true,
    };
    const result = resolveTools(undefined, perms, ['read_file', 'shell']);
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('authorization check runs before known-tool check', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    // 'shell' is a known tool but not in authorized list → permission_denied (auth gate)
    const result = resolveTools(['read_file', 'shell'], perms, ['read_file']);
    expect(result.resolved).toEqual(['read_file']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].toolName).toBe('shell');
    expect(result.errors[0].code).toBe('permission_denied');
    expect(result.errors[0].message).toContain('not authorized');
  });

  it('coarse permission check applies after authorization gate', () => {
    const perms: ResolvedAgentPermissions = {
      canRead: true,
      canWrite: false,
      canRunShell: false,
      canSearchWeb: false,
      canUseNestedAgents: false,
    };
    // search_replace is authorized but coarse canWrite is denied
    const result = resolveTools(['read_file', 'search_replace'], perms, ['read_file', 'search_replace']);
    expect(result.resolved).toEqual(['read_file']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].toolName).toBe('search_replace');
    expect(result.errors[0].code).toBe('permission_denied');
    expect(result.errors[0].message).toContain('canWrite');
  });
});
