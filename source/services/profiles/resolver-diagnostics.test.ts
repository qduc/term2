import { describe, expect, it } from 'vitest';
import { resolveProfile, type ProfileDefinition, type ProfileRegistry } from './index.js';

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

const definition = (id: string, blocks: ProfileDefinition['blocks'], extendsId?: string): ProfileDefinition => ({
  schemaVersion: 1,
  id,
  version: '1',
  name: id,
  ...(extendsId ? { extends: extendsId } : {}),
  blocks,
});

describe('Profile resolver diagnostics', () => {
  it('rejects an unknown enforcement policy', () => {
    expect(() =>
      resolveProfile(
        'builtin:custom',
        registry([
          definition('custom', { enforcement: { kind: 'enforcement', policies: ['builtin:policy/missing'] } }),
        ]),
      ),
    ).toThrow(/unknown-policy/);
  });

  it('rejects an instruction operation that is invalid for the slot', () => {
    // `remove` passes schema validation (id-only entry) but is not valid on the
    // workflow slot; the resolver must reject it with unknown-operation.
    const blocks = {
      instructions: {
        kind: 'instructions' as const,
        workflow: { id: 'w', operation: 'remove' as const },
      },
    };
    expect(() => resolveProfile('builtin:custom', registry([definition('custom', blocks)]))).toThrow(
      /unknown-operation/,
    );
  });

  it('rejects a block reference whose registered kind mismatches the slot', () => {
    const blocks = { context: { use: 'builtin:tools/standard', kind: 'context' as const } };
    const toolsBlock = { id: 'builtin:tools/standard', kind: 'tools' as const, definition: { kind: 'tools' as const } };
    expect(() => resolveProfile('builtin:custom', registry([definition('custom', blocks)], [toolsBlock]))).toThrow(
      /block-kind-mismatch/,
    );
  });

  it('rejects an unknown registered instruction block reference', () => {
    const blocks = { instructions: { kind: 'instructions' as const, workflow: { use: 'builtin:instructions/nope' } } };
    expect(() => resolveProfile('builtin:custom', registry([definition('custom', blocks)]))).toThrow(/unknown-block/);
  });

  it('collapses duplicate identical integration references and fails conflicting ones', () => {
    const base = definition(
      'base',
      {
        integrations: {
          kind: 'integrations',
          integrations: [
            { use: 'builtin:integration/mentor', required: false },
            { use: 'builtin:integration/mentor', required: false },
          ],
        },
      },
      undefined,
    );
    const resolved = resolveProfile(
      'builtin:base',
      registry([base], [], [], [{ id: 'builtin:integration/mentor', kind: 'integrations' }]),
    );
    expect(resolved.integrations.size).toBe(1);

    const conflicting = definition(
      'conflicting',
      {
        integrations: {
          kind: 'integrations',
          integrations: [
            { use: 'builtin:integration/mentor', required: false },
            { use: 'builtin:integration/mentor', required: true },
          ],
        },
      },
      undefined,
    );
    expect(() =>
      resolveProfile(
        'builtin:conflicting',
        registry([conflicting], [], [], [{ id: 'builtin:integration/mentor', kind: 'integrations' }]),
      ),
    ).toThrow(/conflicting-integration/);
  });

  it('enforces the parent-chain depth limit', () => {
    const depth = 40;
    const profiles: ProfileDefinition[] = [];
    for (let i = 0; i < depth; i++) {
      profiles.push(definition(`p${i}`, {}, i > 0 ? `builtin:p${i - 1}` : undefined));
    }
    expect(() => resolveProfile('builtin:p39', registry(profiles), { maxParentDepth: 32 })).toThrow(
      /parent-chain depth exceeds/,
    );
  });

  it('keeps resolution side-effect free and immutable across calls', () => {
    const a = resolveProfile('builtin:standard');
    const b = resolveProfile('builtin:standard');
    expect(a).not.toBe(b);
    expect(a.identity.digest).toBe(b.identity.digest);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.enforcement.policies)).toBe(true);
    expect(() => ((a as any).instructions.identity = { kind: 'markdown', content: 'x' })).toThrow();
  });
});
