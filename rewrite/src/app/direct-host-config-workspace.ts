import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import type { Principal, WorkspaceGrant } from '../host/index.js';
import type { Workspace } from '../tools/index.js';
import { DirectCandidateRegistry } from './direct-host-config-candidates.js';
import type { CandidateBrowse, CandidateValidation } from './direct-host-config-candidates.js';
import { DirectHostConfigError, requirePrincipal } from './direct-host-config-error.js';
import {
  canonicalizeUse,
  contained,
  grantFromInput,
  inspectRestoredRoot,
  loadDynamicGrants,
  requireCanonicalDirectory,
  requireStateDirectory,
  saveDynamicGrants,
} from './direct-host-config-workspace-grants.js';
import type { GrantRecord, WorkspaceAccess } from './direct-host-config-workspace-grants.js';

export type { WorkspaceAccess, GrantRecord } from './direct-host-config-workspace-grants.js';
export type { CandidateBrowse, CandidateValidation } from './direct-host-config-candidates.js';

export type WorkspaceAlias = { workspaceId: string; label: string; access: WorkspaceAccess };
export type CandidateSelection = {
  workspaceId: string;
  displayName: string;
  binding: {
    /** Wire-only id. Not a Session and not stored. */
    sessionId: string;
    ownerUserId: string;
    workspaceId: string;
    grantVersion: number;
    canonicalRoot: string;
    access: WorkspaceAccess;
  };
};
export type WorkspaceAuthorityResult = {
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly grantVersion: number;
};
export type DirectWorkspaceGrantInput = {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly label: string;
  readonly root: string;
  readonly access: WorkspaceAccess;
};

/**
 * Persisted workspace grants for one direct process.
 * One canonical root has one grant. Access is fixed at admission and is never widened.
 * Dynamic grants go only to `stateDirectory/direct-workspace-grants.json`.
 * Session ownership is `{ client: ownerUserId, id: workspaceId }` on the direct log, not this file.
 */
export class DirectWorkspaceAuthority {
  readonly #allowWrite: boolean;
  readonly #roots: readonly string[];
  readonly #stateDirectory?: string;
  readonly #grants = new Map<string, GrantRecord>();
  readonly #candidates: DirectCandidateRegistry;
  #issuedVersion = 1;

  constructor(options: {
    readonly allowWrite: boolean;
    readonly allowedRoots: readonly string[];
    readonly staticGrants?: readonly DirectWorkspaceGrantInput[];
    readonly stateDirectory?: string;
    readonly now?: () => number;
  }) {
    this.#allowWrite = options.allowWrite;
    this.#roots = options.allowedRoots.map((root) => requireCanonicalDirectory(root));
    this.#candidates = new DirectCandidateRegistry(this.#roots, options.now);
    for (const input of options.staticGrants ?? []) this.#addStatic(input);
    if (options.stateDirectory !== undefined) {
      this.#stateDirectory = requireStateDirectory(options.stateDirectory);
      for (const grant of loadDynamicGrants(this.#stateDirectory)) {
        inspectRestoredRoot(grant.root);
        this.#insert(grant);
        this.#issuedVersion = Math.max(this.#issuedVersion, grant.grantVersion);
      }
    }
  }

  /** Full alias list. The server applies its own 1–50 limit and rejects cursors. */
  list(principal: Principal): WorkspaceAlias[] {
    const owner = requirePrincipal(principal);
    return [...this.#grants.values()]
      .filter((grant) => grant.ownerUserId === owner)
      .map(({ workspaceId, label, access }) => ({ workspaceId, label, access }));
  }

  validate(principal: Principal, absolutePath: string): CandidateValidation {
    return this.#candidates.validate(requirePrincipal(principal), absolutePath);
  }

  browse(principal: Principal, candidateId: string, child?: string): CandidateBrowse {
    return this.#candidates.browse(requirePrincipal(principal), candidateId, child);
  }

  select(principal: Principal, candidateId: string, access: WorkspaceAccess): CandidateSelection {
    const owner = requirePrincipal(principal);
    if (access !== 'read' && access !== 'read_write') throw new DirectHostConfigError('validation_error', 'candidate');
    const taken = this.#candidates.take(owner, candidateId);
    this.#assertSelectable(taken.canonicalRoot, access);
    const existing = this.#byRoot(taken.canonicalRoot);
    if (existing) {
      if (existing.ownerUserId !== owner) {
        throw new DirectHostConfigError('workspace_owner_mismatch', 'authority');
      }
      if (existing.access !== access) {
        throw new DirectHostConfigError('workspace_grant_mismatch', 'authority', {
          existingAccess: existing.access,
          grantStorage: existing.dynamic ? (this.#stateDirectory ? 'persisted' : 'memory') : 'static',
        });
      }
      this.#candidates.expire(candidateId);
      return selection(existing);
    }
    const record: GrantRecord = {
      workspaceId: `ws_${randomUUID().replaceAll('-', '')}`,
      ownerUserId: owner,
      label: taken.displayName,
      root: taken.canonicalRoot,
      access,
      grantVersion: this.#issuedVersion + 1,
      dynamic: true,
    };
    this.#grants.set(record.workspaceId, record);
    try {
      this.#persist();
    } catch {
      this.#grants.delete(record.workspaceId);
      throw new DirectHostConfigError('workspace_grant_not_persisted', 'authority');
    }
    this.#issuedVersion = record.grantVersion;
    this.#candidates.expire(candidateId);
    return selection(record);
  }

  /** HTTP create uses the stored grant's access. A client cannot choose a wider one. */
  resolveGrant(principal: Principal, workspaceId: string): WorkspaceGrant {
    const record = this.#owned(principal, workspaceId);
    this.#assertBoundary(this.#exactRoot(record), record.access, 'authority');
    return { workspaceId: record.workspaceId, access: record.access };
  }

  /** Host create. Requested access must equal the grant. */
  resolveWorkspace(principal: Principal, grant: WorkspaceGrant): WorkspaceAuthorityResult {
    const record = this.#owned(principal, grant.workspaceId);
    if (grant.access !== record.access) throw new DirectHostConfigError('workspace_grant_mismatch', 'authority');
    const root = this.#exactRoot(record);
    this.#assertBoundary(root, record.access, 'authority');
    return {
      workspace: { root, access: record.access, target: 'local' },
      workspaceId: record.workspaceId,
      grantVersion: record.grantVersion,
    };
  }

  /** Store callback has only a path. Ambiguous or missing roots fail closed. */
  resolveStoredRoot(root: string): Workspace {
    const canonical = canonicalizeUse(root);
    const matches = [...this.#grants.values()].filter((grant) => grant.root === canonical);
    if (matches.length !== 1)
      throw new DirectHostConfigError(
        matches.length === 0 ? 'workspace_authority_revoked' : 'workspace_grant_mismatch',
        'authority',
      );
    const record = matches[0]!;
    this.#assertBoundary(canonical, record.access, 'authority');
    return { root: canonical, access: record.access, target: 'local' };
  }

  #owned(principal: Principal, workspaceId: string): GrantRecord {
    const owner = requirePrincipal(principal);
    const record = this.#grants.get(workspaceId);
    if (!record) throw new DirectHostConfigError('workspace_not_found', 'authority');
    if (record.ownerUserId !== owner) throw new DirectHostConfigError('workspace_owner_mismatch', 'authority');
    if (record.dynamic && !this.#roots.some((root) => contained(root, record.root))) {
      throw new DirectHostConfigError('workspace_authority_revoked', 'authority');
    }
    return record;
  }

  #byRoot(root: string): GrantRecord | undefined {
    return [...this.#grants.values()].find((grant) => grant.root === root);
  }

  #exactRoot(record: GrantRecord): string {
    const root = canonicalizeUse(record.root);
    if (root !== record.root) throw new DirectHostConfigError('workspace_root_not_canonical', 'authority');
    return root;
  }

  #addStatic(input: DirectWorkspaceGrantInput): void {
    const root = requireCanonicalDirectory(input.root);
    const record = grantFromInput({ ...input, root, grantVersion: 1, dynamic: false });
    if (record.access === 'read_write' && !this.#allowWrite)
      throw new DirectHostConfigError('configuration_invalid', 'startup');
    this.#assertBoundary(root, record.access, 'authority');
    this.#insert(record);
  }

  #insert(record: GrantRecord): void {
    if (this.#grants.has(record.workspaceId) || this.#byRoot(record.root)) {
      throw new DirectHostConfigError('configuration_invalid', 'startup');
    }
    this.#grants.set(record.workspaceId, record);
  }

  #assertSelectable(root: string, access: WorkspaceAccess): void {
    this.#assertBoundary(root, 'read', 'candidate');
    if (access === 'read_write') this.#assertBoundary(root, access, 'authority');
  }

  #assertBoundary(root: string, access: WorkspaceAccess, surface: 'candidate' | 'authority'): void {
    try {
      accessSync(root, constants.R_OK | constants.X_OK);
    } catch {
      throw new DirectHostConfigError(
        surface === 'candidate' ? 'workspace_not_readable' : 'workspace_root_unavailable',
        surface,
      );
    }
    if (access !== 'read_write') return;
    if (!this.#allowWrite) throw new DirectHostConfigError('write_not_allowed', 'authority');
    try {
      accessSync(root, constants.W_OK);
    } catch {
      throw new DirectHostConfigError('write_not_allowed', 'authority');
    }
  }

  #persist(): void {
    if (!this.#stateDirectory) return;
    saveDynamicGrants(this.#stateDirectory, [...this.#grants.values()]);
  }
}

function selection(record: GrantRecord): CandidateSelection {
  return {
    workspaceId: record.workspaceId,
    displayName: record.label,
    binding: {
      sessionId: randomUUID(),
      ownerUserId: record.ownerUserId,
      workspaceId: record.workspaceId,
      grantVersion: record.grantVersion,
      canonicalRoot: record.root,
      access: record.access,
    },
  };
}
