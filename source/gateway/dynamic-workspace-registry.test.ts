import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DynamicWorkspaceRegistry, DynamicWorkspaceRegistryError } from './dynamic-workspace-registry.js';
import { WorkspaceAdmission } from './workspace-admission.js';
import type { GatewayManifest } from './contracts.js';
import { createRealWorkspaceBoundaryProbe } from './workspace-boundary-probe.js';

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-dynamic-workspace-'));
  roots.push(root);
  return root;
};
const makeRegistry = (root: string, now = () => Date.now()) => {
  const manifest: GatewayManifest = { version: 1, grants: [] };
  const admission = new WorkspaceAdmission(manifest, {
    allowWrite: true,
    boundaryProbe: createRealWorkspaceBoundaryProbe({ allowWrite: true }),
  });
  return new DynamicWorkspaceRegistry({ admission, allowedRoots: [root], now });
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DynamicWorkspaceRegistry', () => {
  it('validates a local folder without returning its authoritative path', () => {
    const root = makeRoot();
    const child = path.join(root, 'project');
    mkdirSync(child);
    const registry = makeRegistry(root);
    const result = registry.validateCandidate(child, 'user-a');
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('test setup');
    expect(result.candidateId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.displayName).toBe('project');
    expect(JSON.stringify(result)).not.toContain(child);
    expect(result.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('rejects missing, file, outside, and invalid paths in validation order', () => {
    const root = makeRoot();
    const registry = makeRegistry(root);
    const missing = registry.validateCandidate(path.join(root, 'missing'));
    expect(missing).toMatchObject({ valid: false, reasonCode: 'workspace_root_unavailable' });
    const file = path.join(root, 'README.md');
    writeFileSync(file, 'fixture');
    expect(registry.validateCandidate(file)).toMatchObject({ valid: false, reasonCode: 'workspace_root_unavailable' });
    expect(registry.validateCandidate(path.join(root, '..', 'outside'))).toMatchObject({
      valid: false,
      reasonCode: 'workspace_root_unavailable',
    });
    expect(registry.validateCandidate('relative/path')).toMatchObject({
      valid: false,
      reasonCode: 'workspace_root_unavailable',
    });
  });

  it('allows an in-root symlink and rejects an outside-root symlink', () => {
    const root = makeRoot();
    const inside = path.join(root, 'inside');
    const outside = makeRoot();
    mkdirSync(inside);
    symlinkSync(inside, path.join(root, 'inside-link'));
    symlinkSync(outside, path.join(root, 'outside-link'));
    const registry = makeRegistry(root);
    expect(registry.validateCandidate(path.join(root, 'inside-link')).valid).toBe(true);
    expect(registry.validateCandidate(path.join(root, 'outside-link'))).toMatchObject({
      valid: false,
      reasonCode: 'workspace_path_escape',
    });
  });

  it('reports permission denial without relying on process-root chmod behavior', () => {
    const root = makeRoot();
    const registry = new DynamicWorkspaceRegistry({
      admission: new WorkspaceAdmission({ version: 1, grants: [] }, { allowWrite: true }),
      allowedRoots: [root],
      fs: {
        realpathSync: (value) => value,
        statSync: () => ({ isDirectory: () => true }),
        accessSync: (_value, mode) => {
          if (mode !== 0) throw new Error('permission denied');
        },
        readdirSync: () => [],
      },
    });
    expect(registry.validateCandidate(root)).toMatchObject({ valid: false, reasonCode: 'workspace_not_readable' });
  });

  it('browses with opaque child tokens and rejects outside symlink entries', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'child'));
    writeFileSync(path.join(root, 'README.md'), 'fixture');
    const outside = makeRoot();
    symlinkSync(outside, path.join(root, 'escape'));
    const registry = makeRegistry(root);
    const validated = registry.validateCandidate(root, 'user-a');
    if (!validated.valid) throw new Error('test setup');
    const result = registry.browse(validated.candidateId, undefined, 'user-a');
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'child', type: 'directory', selectable: true, childToken: expect.any(String) }),
        expect.objectContaining({ name: 'README.md', type: 'file', selectable: false }),
        expect.objectContaining({
          name: 'escape',
          type: 'symlink',
          selectable: false,
          rejectionReason: 'workspace_path_escape',
        }),
      ]),
    );
    const child = result.entries.find((entry) => entry.name === 'child')!;
    expect(registry.browse(validated.candidateId, child.childToken, 'user-a').entries).toEqual([]);
    expect(() => registry.browse(validated.candidateId, child.childToken, 'user-b')).toThrowError(
      new DynamicWorkspaceRegistryError('workspace_owner_mismatch'),
    );
  });

  it('re-realpaths a child token and rejects replacement by an outside symlink', () => {
    const root = makeRoot();
    const child = path.join(root, 'child');
    const outside = makeRoot();
    mkdirSync(child);
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    const registry = makeRegistry(root);
    const validated = registry.validateCandidate(root, 'user-a');
    if (!validated.valid) throw new Error('test setup');
    const browsed = registry.browse(validated.candidateId, undefined, 'user-a');
    const token = browsed.entries.find((entry) => entry.name === 'child')?.childToken;
    expect(token).toEqual(expect.any(String));
    rmSync(child, { recursive: true, force: true });
    symlinkSync(outside, child);
    expect(() => registry.browse(validated.candidateId, token, 'user-a')).toThrowError(
      new DynamicWorkspaceRegistryError('workspace_path_escape'),
    );
    expect(registry.browseTokenCount).toBe(0);
  });

  it('enforces per-owner and global candidate quotas', () => {
    const root = makeRoot();
    const manifest: GatewayManifest = { version: 1, grants: [] };
    const admission = new WorkspaceAdmission(manifest, { allowWrite: true });
    const registry = new DynamicWorkspaceRegistry({
      admission,
      allowedRoots: [root],
      maxCandidates: 2,
      maxCandidatesPerOwner: 1,
    });
    expect(registry.validateCandidate(root, 'user-a')).toMatchObject({ valid: true });
    expect(registry.validateCandidate(root, 'user-a')).toMatchObject({
      valid: false,
      reasonCode: 'candidate_registry_full',
    });
    expect(registry.validateCandidate(root, 'user-b')).toMatchObject({ valid: true });
    expect(registry.validateCandidate(root, 'user-c')).toMatchObject({
      valid: false,
      reasonCode: 'candidate_registry_full',
    });
  });

  it('bounds browse tokens in the candidate budget and expires them', () => {
    let now = 100;
    const root = makeRoot();
    mkdirSync(path.join(root, 'one'));
    mkdirSync(path.join(root, 'two'));
    const registry = new DynamicWorkspaceRegistry({
      admission: new WorkspaceAdmission({ version: 1, grants: [] }, { allowWrite: true }),
      allowedRoots: [root],
      maxCandidates: 4,
      maxRegistryEntries: 2,
      browseTokenTtlMs: 10,
      now: () => now,
    });
    const validated = registry.validateCandidate(root, 'user-a');
    if (!validated.valid) throw new Error('test setup');
    registry.browse(validated.candidateId, undefined, 'user-a');
    expect(registry.browseTokenCount).toBeLessThanOrEqual(1);
    now += 11;
    expect(registry.browseTokenCount).toBe(0);
  });

  it('expires candidates and selects distinct roots through WorkspaceAdmission', () => {
    let now = 100;
    const root = makeRoot();
    const second = makeRoot();
    const registry = makeRegistry(root, () => now);
    const first = registry.validateCandidate(root, 'user-a');
    if (!first.valid) throw new Error('test setup');
    const selection = registry.select(first.candidateId, 'read_write', 'user-a');
    expect(selection.binding.canonicalRoot).toBe(root);
    expect(selection.binding.workspaceId).toBe(selection.workspaceId);
    expect(Object.isFrozen(selection.binding)).toBe(true);
    expect(registry.pin(selection.binding).getCwd()).toBe(root);

    const secondRegistry = makeRegistry(second);
    const secondCandidate = secondRegistry.validateCandidate(second, 'user-a');
    if (!secondCandidate.valid) throw new Error('test setup');
    expect(secondRegistry.select(secondCandidate.candidateId, 'read_write', 'user-a').binding.canonicalRoot).toBe(
      second,
    );

    const pending = registry.validateCandidate(root, 'user-a');
    if (!pending.valid) throw new Error('test setup');
    now += 5 * 60_000 + 1;
    expect(() => registry.browse(pending.candidateId, undefined, 'user-a')).toThrowError(
      new DynamicWorkspaceRegistryError('candidate_expired'),
    );
  });
});
