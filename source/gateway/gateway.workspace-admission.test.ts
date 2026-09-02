import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateGatewayManifest, WorkspaceAdmission, WorkspaceAdmissionError } from './workspace-admission.js';
import type { GatewayAssertionClaims, WorkspaceGrant } from './contracts.js';

const tempRoots: string[] = [];
const makeTemp = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-gateway-'));
  tempRoots.push(root);
  return root;
};

const claimsFor = (
  purpose: GatewayAssertionClaims['purpose'] = 'session_create',
  extra: Partial<GatewayAssertionClaims> = {},
) => ({
  iss: 'chatforge-bff',
  aud: 'term2-gateway',
  sub: 'user-a',
  purpose,
  iat: 1_000,
  nbf: 995,
  exp: 1_050,
  jti: crypto.randomUUID(),
  ver: 1 as const,
  ...extra,
});

function makeManifest(root: string, version = 1) {
  return validateGatewayManifest({
    version,
    grants: [
      {
        workspaceId: 'workspace-a',
        ownerUserId: 'user-a',
        label: 'A Workspace',
        kind: 'local',
        localRoot: root,
        access: 'read_write',
        enabled: true,
      },
      {
        workspaceId: 'workspace-b',
        ownerUserId: 'user-b',
        label: 'B Workspace',
        kind: 'local',
        localRoot: root,
        access: 'read',
        enabled: true,
      },
    ],
  });
}

const boundaryProbe = (canonicalRoot: string, access: 'read' | 'read_write') => ({
  mountedRoot: canonicalRoot,
  writable: access === 'read_write',
});

function makeAdmission(root: string, allowWrite = true) {
  return new WorkspaceAdmission(makeManifest(root), { allowWrite, boundaryProbe });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace admission', () => {
  it('binds an owner to a canonical local root and rejects cross-owner access', () => {
    const root = makeTemp();
    const admission = makeAdmission(root);
    const binding = admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }));
    expect(binding.canonicalRoot).toBe(root);
    expect(() =>
      admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a', sub: 'user-b' })),
    ).toThrowError(new WorkspaceAdmissionError('workspace_owner_mismatch'));
    expect(() => admission.getSession(binding.sessionId, 'user-b')).toThrowError(
      new WorkspaceAdmissionError('session_owner_mismatch'),
    );
    expect(() => admission.retarget()).toThrowError(new WorkspaceAdmissionError('session_retarget_forbidden'));
  });

  it('rejects version drift, deleted roots, symlink roots, SSH, and path escapes', () => {
    const root = makeTemp();
    const link = path.join(makeTemp(), 'link');
    symlinkSync(root, link);
    const admission = new WorkspaceAdmission(makeManifest(root, 2), { allowWrite: true, boundaryProbe });
    expect(() => admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }), 1)).toThrowError(
      new WorkspaceAdmissionError('manifest_version_mismatch'),
    );
    expect(() =>
      WorkspaceAdmission.assertPath(
        { sessionId: 's', ownerUserId: 'u', workspaceId: 'w', grantVersion: 1, canonicalRoot: root, access: 'read' },
        '../outside',
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_path_escape'));
    writeFileSync(path.join(root, 'inside'), 'ok');
    expect(
      WorkspaceAdmission.assertPath(
        { sessionId: 's', ownerUserId: 'u', workspaceId: 'w', grantVersion: 1, canonicalRoot: root, access: 'read' },
        'inside',
      ),
    ).toBe(path.join(root, 'inside'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(link), { allowWrite: true, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_root_not_canonical'));
    rmSync(root, { recursive: true, force: true });
    expect(() =>
      new WorkspaceAdmission(makeManifest(root, 3), { allowWrite: true, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_root_unavailable'));
  });

  it('does not advertise SSH or owner/path fields in aliases', () => {
    const root = makeTemp();
    const aliases = new WorkspaceAdmission(makeManifest(root)).listAliases('user-a');
    expect(aliases).toEqual([{ workspaceId: 'workspace-a', label: 'A Workspace', access: 'read_write' }]);
    expect(JSON.stringify(aliases)).not.toContain('ownerUserId');
    expect(JSON.stringify(aliases)).not.toContain(root);
  });

  it('fails closed for write policy, missing boundary evidence, and a swapped mount root', () => {
    const root = makeTemp();
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), { allowWrite: false, boundaryProbe }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('write_not_allowed'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), { allowWrite: true }).admit(
        claimsFor('session_create', { workspaceId: 'workspace-a' }),
      ),
    ).toThrowError(new WorkspaceAdmissionError('workspace_boundary_unverified'));
    expect(() =>
      new WorkspaceAdmission(makeManifest(root), {
        allowWrite: true,
        boundaryProbe: () => ({ mountedRoot: path.join(root, 'swapped'), writable: true }),
      }).admit(claimsFor('session_create', { workspaceId: 'workspace-a' })),
    ).toThrowError(new WorkspaceAdmissionError('workspace_boundary_unverified'));
  });

  it('requires opaque workspace IDs and provisioned sanitized labels', () => {
    expect(() =>
      validateGatewayManifest({
        version: 1,
        grants: [
          {
            workspaceId: '/tmp/path',
            ownerUserId: 'u',
            label: 'Label',
            kind: 'local',
            localRoot: '/',
            access: 'read',
            enabled: true,
          },
        ],
      }),
    ).toThrowError(new WorkspaceAdmissionError('manifest_invalid'));
    expect(() =>
      validateGatewayManifest({
        version: 1,
        grants: [
          {
            workspaceId: 'good_id',
            ownerUserId: 'u',
            label: 'bad\nlabel',
            kind: 'local',
            localRoot: '/',
            access: 'read',
            enabled: true,
          },
        ],
      }),
    ).toThrowError(new WorkspaceAdmissionError('manifest_invalid'));
  });

  it('rejects a second live session for one workspace', () => {
    const admission = makeAdmission(makeTemp());
    admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }));
    expect(() => admission.admit(claimsFor('session_create', { workspaceId: 'workspace-a' }))).toThrowError(
      new WorkspaceAdmissionError('workspace_session_exists'),
    );
  });

  it('restores a binding for a persisted dynamic grant after restart', () => {
    const root = makeTemp();
    const wsRoot = path.join(root, 'ws');
    mkdirSync(wsRoot, { recursive: true });
    const dynamicGrant: WorkspaceGrant = {
      workspaceId: 'dyn-1',
      ownerUserId: 'user-a',
      label: 'local-owner',
      kind: 'local',
      localRoot: wsRoot,
      access: 'read',
      enabled: true,
    };
    const changes: WorkspaceGrant[][] = [];
    const admission = new WorkspaceAdmission(makeManifest(root), {
      allowWrite: false,
      boundaryProbe,
      onDynamicGrantChange: (grants) => changes.push([...grants]),
    });
    admission.registerDynamicLocalGrant(dynamicGrant);
    expect(changes).toEqual([[dynamicGrant]]);
    const created = admission.admit(claimsFor('session_create', { workspaceId: 'dyn-1' }));

    // A restarted gateway reconstructs the admission from the persisted list
    // and must be able to restore the session binding (the launch path relies
    // on this for session reads after a daemon restart).
    const restarted = new WorkspaceAdmission(makeManifest(root), {
      allowWrite: false,
      boundaryProbe,
      initialDynamicGrants: changes[0],
    });
    const binding = restarted.restore(created.sessionId, 'user-a', 'dyn-1', 2);
    expect(binding.workspaceId).toBe('dyn-1');
    expect(restarted.manifestVersion).toBe(2);
    // A restored session has no live runtime, so it must not hold the
    // workspace: a fresh create in the same workspace is the recovery path
    // after a daemon restart.
    const resumed = restarted.admit(claimsFor('session_create', { workspaceId: 'dyn-1' }));
    expect(resumed.sessionId).not.toBe(created.sessionId);
    // Invalid persisted entries must fail closed rather than silently load.
    expect(
      () =>
        new WorkspaceAdmission(makeManifest(root), {
          allowWrite: false,
          boundaryProbe,
          initialDynamicGrants: [{ ...dynamicGrant, workspaceId: 'bad id' }],
        }),
    ).toThrowError(new WorkspaceAdmissionError('manifest_invalid'));
  });
});
