import { describe, expect, it } from 'vitest';
import {
  builtinProfileRegistry,
  legacyModeAdapter,
  resolveProfile,
  type ProfileDefinition,
  type ProfileRegistry,
} from './index.js';

const registry = (
  profiles: ProfileDefinition[],
  blocks: any[] = [],
  policies: any[] = [],
  integrations: any[] = [],
): ProfileRegistry => ({
  profiles: new Map(profiles.map((profile) => [`builtin:${profile.id}`, profile])),
  blocks: new Map(blocks.map((block: any) => [block.id, block])),
  policies: new Map(policies.map((policy: any) => [policy.id, policy])),
  integrations: new Map(integrations.map((integration: any) => [integration.id, integration])),
});

describe('Profile resolver', () => {
  it('resolves every built-in through one resolver entry point', () => {
    expect(resolveProfile('builtin:standard').instructions.identity).toEqual({ kind: 'model-family-base' });
    expect(resolveProfile('builtin:lite').instructions.identity.kind).toBe('markdown');
    expect(resolveProfile('builtin:plan').enforcement.denials).toContain('shell-mutation');
    expect(resolveProfile('builtin:mentor').integrations.get('builtin:integration/mentor')).toMatchObject({
      required: false,
      available: false,
    });
    expect(
      resolveProfile('builtin:orchestrator').integrations.get('builtin:integration/async-subagents'),
    ).toMatchObject({
      required: true,
      available: true,
    });
  });

  it('fails a required async integration when the runtime does not provide it', () => {
    expect(() => resolveProfile('builtin:orchestrator', { availableIntegrations: new Set<string>() })).toThrow(
      /async-subagents.*unavailable/,
    );
    expect(resolveProfile('builtin:mentor', { availableIntegrations: new Set<string>() }).availability.available).toBe(
      true,
    );
  });

  it('applies typed inheritance and produces the same digest for declared and inherited semantics', () => {
    const base: ProfileDefinition = {
      schemaVersion: 1,
      id: 'base',
      version: '1',
      name: 'Base',
      blocks: { instructions: { kind: 'instructions', workflow: { content: 'work' } } },
    };
    const child: ProfileDefinition = {
      schemaVersion: 1,
      id: 'child',
      version: '1',
      name: 'Child',
      extends: 'builtin:base',
      blocks: {},
    };
    const equivalent: ProfileDefinition = { ...child, id: 'equivalent', extends: undefined, blocks: base.blocks };
    const custom = registry([base, child, equivalent]);
    expect(resolveProfile('builtin:child', custom).instructions.workflow).toEqual({
      kind: 'markdown',
      content: 'work',
    });
    expect(resolveProfile('builtin:child', custom).identity.digest).toBe(
      resolveProfile('builtin:equivalent', custom).identity.digest,
    );
  });

  it('merges context by ID and applies tool exclusion over inclusion', () => {
    const base: ProfileDefinition = {
      schemaVersion: 1,
      id: 'base',
      version: '1',
      name: 'Base',
      blocks: {
        context: { kind: 'context', sources: [{ id: 'env', source: 'environment' }] },
        tools: { kind: 'tools', include: ['shell', 'web'] },
      },
    };
    const child: ProfileDefinition = {
      schemaVersion: 1,
      id: 'child',
      version: '1',
      name: 'Child',
      extends: 'builtin:base',
      blocks: {
        context: { kind: 'context', sources: [{ id: 'env', source: 'workspace' }] },
        tools: { kind: 'tools', include: ['filesystem-write'], exclude: ['web'] },
      },
    };
    const resolved = resolveProfile('builtin:child', registry([base, child]));
    expect(resolved.context.sources).toEqual([{ id: 'env', source: 'workspace', enabled: true, priority: 0 }]);
    expect(resolved.tools.capabilities).toEqual(new Set(['shell', 'filesystem-write']));
  });

  it('replaces slots, appends guidance, and removes guidance by stable ID', () => {
    const base: ProfileDefinition = {
      schemaVersion: 1,
      id: 'base',
      version: '1',
      name: 'Base',
      blocks: {
        instructions: {
          kind: 'instructions',
          workflow: { content: 'base workflow' },
          guidance: [
            { id: 'keep', content: 'keep me' },
            { id: 'remove', content: 'remove me' },
          ],
        },
      },
    };
    const child: ProfileDefinition = {
      schemaVersion: 1,
      id: 'child',
      version: '1',
      name: 'Child',
      extends: 'builtin:base',
      blocks: {
        instructions: {
          kind: 'instructions',
          workflow: { content: 'child workflow' },
          guidance: [
            { id: 'added', content: 'added' },
            { id: 'remove', operation: 'remove' },
          ],
        },
      },
    };
    const result = resolveProfile('builtin:child', registry([base, child]));
    expect(result.instructions.workflow).toEqual({ kind: 'markdown', content: 'child workflow' });
    expect(result.instructions.guidance).toEqual([
      { id: 'keep', content: { kind: 'markdown', content: 'keep me' } },
      { id: 'added', content: { kind: 'markdown', content: 'added' } },
    ]);
  });

  it('accumulates restrictive policies and rejects unknown capabilities and policies', () => {
    const policy = { id: 'builtin:policy/custom', kind: 'enforcement' as const, denials: ['custom-denial'] };
    const definition: ProfileDefinition = {
      schemaVersion: 1,
      id: 'custom',
      version: '1',
      name: 'Custom',
      blocks: {
        tools: { kind: 'tools', include: ['not-a-capability'] },
        enforcement: { kind: 'enforcement', policies: ['builtin:policy/custom', 'builtin:policy/missing'] },
      },
    };
    expect(() => resolveProfile('builtin:custom', registry([definition], [], [policy]))).toThrow(/unknown-capability/);
  });

  it('reports an unavailable requirement without silently changing the selected profile', () => {
    const definition: ProfileDefinition = {
      schemaVersion: 1,
      id: 'needs-memory',
      version: '1',
      name: 'Needs memory',
      blocks: {},
      requires: [{ kind: 'capability', value: 'memory' }],
    };
    const result = resolveProfile('builtin:needs-memory', registry([definition]));
    expect(result.availability).toMatchObject({ available: false });
    expect(result.availability.diagnostics[0]).toMatchObject({ code: 'unsatisfied-requirement' });
  });

  it('uses full cycle diagnostics and rejects missing parents', () => {
    const a: ProfileDefinition = {
      schemaVersion: 1,
      id: 'a',
      version: '1',
      name: 'A',
      extends: 'builtin:b',
      blocks: {},
    };
    const b: ProfileDefinition = {
      schemaVersion: 1,
      id: 'b',
      version: '1',
      name: 'B',
      extends: 'builtin:a',
      blocks: {},
    };
    expect(() => resolveProfile('builtin:a', registry([a, b]))).toThrow(/builtin:a -> builtin:b -> builtin:a/);
    expect(() => resolveProfile('builtin:a', registry([{ ...a, extends: 'builtin:nope' }]))).toThrow(/builtin:nope/);
  });
});

describe('legacyModeAdapter', () => {
  it('uses the current malformed-state precedence and treats missing orchestrator as false', () => {
    expect(legacyModeAdapter.profileIdFromLegacyMode({ mentorMode: true, planMode: true })).toBe('builtin:plan');
    expect(legacyModeAdapter.profileIdFromLegacyMode({ liteMode: true, orchestratorMode: true })).toBe(
      'builtin:orchestrator',
    );
    expect(legacyModeAdapter.profileIdFromLegacyMode({ mentorMode: true })).toBe('builtin:mentor');
    expect(legacyModeAdapter.normalizeLegacyMode({ mentorMode: true })).toEqual({
      orchestratorMode: false,
      liteMode: false,
      planMode: false,
      mentorMode: true,
    });
  });
});
