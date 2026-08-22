import { createHash } from 'node:crypto';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  GatewayAssertionClaims,
  GatewayManifest,
  SessionBinding,
  WorkspaceAlias,
  WorkspaceGrant,
} from './contracts.js';

export class WorkspaceAdmissionError extends Error {
  readonly code:
    | 'manifest_invalid'
    | 'manifest_version_mismatch'
    | 'workspace_not_found'
    | 'workspace_owner_mismatch'
    | 'workspace_disabled'
    | 'ssh_disabled'
    | 'workspace_root_unavailable'
    | 'workspace_root_not_canonical'
    | 'workspace_path_escape'
    | 'session_not_found'
    | 'session_owner_mismatch'
    | 'session_retarget_forbidden'
    | 'workspace_session_exists'
    | 'write_not_allowed'
    | 'workspace_boundary_unverified';

  constructor(code: WorkspaceAdmissionError['code']) {
    super('workspace admission rejected');
    this.name = 'WorkspaceAdmissionError';
    this.code = code;
  }
}

export function validateGatewayManifest(value: unknown): GatewayManifest {
  if (!value || typeof value !== 'object') throw new WorkspaceAdmissionError('manifest_invalid');
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1 || !Array.isArray(candidate.grants)) {
    throw new WorkspaceAdmissionError('manifest_invalid');
  }
  const ids = new Set<string>();
  const grants = candidate.grants.map((grant) => validateGrant(grant, ids));
  if (
    candidate.sha256 !== undefined &&
    (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256))
  ) {
    throw new WorkspaceAdmissionError('manifest_invalid');
  }
  return {
    version: candidate.version as number,
    grants,
    sshTargets: validateSshTargets(candidate.sshTargets),
    sha256: typeof candidate.sha256 === 'string' ? candidate.sha256 : undefined,
  };
}

export function loadGatewayManifest(filename: string, expectedSha256?: string): GatewayManifest {
  try {
    const raw = readFileSync(filename, 'utf8');
    if (expectedSha256 && createHash('sha256').update(raw).digest('hex') !== expectedSha256.toLowerCase()) {
      throw new WorkspaceAdmissionError('manifest_invalid');
    }
    return validateGatewayManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceAdmissionError) throw error;
    throw new WorkspaceAdmissionError('manifest_invalid');
  }
}

function validateGrant(value: unknown, ids: Set<string>): WorkspaceGrant {
  if (!value || typeof value !== 'object') throw new WorkspaceAdmissionError('manifest_invalid');
  const grant = value as Record<string, unknown>;
  if (
    typeof grant.workspaceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(grant.workspaceId) ||
    ids.has(grant.workspaceId) ||
    typeof grant.ownerUserId !== 'string' ||
    !grant.ownerUserId ||
    typeof grant.label !== 'string' ||
    !isProvisionedLabel(grant.label) ||
    (grant.kind !== 'local' && grant.kind !== 'ssh') ||
    (grant.access !== 'read' && grant.access !== 'read_write') ||
    typeof grant.enabled !== 'boolean'
  )
    throw new WorkspaceAdmissionError('manifest_invalid');
  ids.add(grant.workspaceId);
  if (grant.kind === 'local' && (typeof grant.localRoot !== 'string' || !path.isAbsolute(grant.localRoot)))
    throw new WorkspaceAdmissionError('manifest_invalid');
  if (grant.kind === 'ssh' && typeof grant.sshTargetId !== 'string')
    throw new WorkspaceAdmissionError('manifest_invalid');
  return {
    workspaceId: grant.workspaceId,
    ownerUserId: grant.ownerUserId,
    label: grant.label,
    kind: grant.kind,
    localRoot: typeof grant.localRoot === 'string' ? grant.localRoot : undefined,
    sshTargetId: typeof grant.sshTargetId === 'string' ? grant.sshTargetId : undefined,
    remoteRoot: typeof grant.remoteRoot === 'string' ? grant.remoteRoot : undefined,
    access: grant.access,
    enabled: grant.enabled,
  };
}

function validateSshTargets(value: unknown): GatewayManifest['sshTargets'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new WorkspaceAdmissionError('manifest_invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new WorkspaceAdmissionError('manifest_invalid');
    const target = item as Record<string, unknown>;
    if (
      typeof target.sshTargetId !== 'string' ||
      typeof target.host !== 'string' ||
      !Number.isInteger(target.port) ||
      typeof target.username !== 'string' ||
      !Array.isArray(target.remoteRootAllowlist) ||
      typeof target.knownHostsProfile !== 'string' ||
      typeof target.agentProfileId !== 'string' ||
      typeof target.enabled !== 'boolean'
    )
      throw new WorkspaceAdmissionError('manifest_invalid');
    return {
      sshTargetId: target.sshTargetId,
      host: target.host,
      port: target.port as number,
      username: target.username,
      remoteRootAllowlist: target.remoteRootAllowlist.filter((root): root is string => typeof root === 'string'),
      knownHostsProfile: target.knownHostsProfile,
      agentProfileId: target.agentProfileId,
      enabled: target.enabled,
    };
  });
}

export type WorkspaceBoundaryEvidence = {
  mountedRoot: string;
  writable: boolean;
};

export type WorkspaceBoundaryProbe = (
  canonicalRoot: string,
  access: WorkspaceGrant['access'],
) => WorkspaceBoundaryEvidence | false;

export type WorkspaceAdmissionOptions = {
  allowSsh?: boolean;
  allowWrite?: boolean;
  boundaryProbe?: WorkspaceBoundaryProbe;
};

export class WorkspaceAdmission {
  readonly #sessions = new Map<string, SessionBinding>();
  #manifest: GatewayManifest;
  readonly #allowSsh: boolean;
  readonly #allowWrite: boolean;
  readonly #boundaryProbe?: WorkspaceBoundaryProbe;

  constructor(manifest: GatewayManifest, options: WorkspaceAdmissionOptions | boolean = {}) {
    const resolved = typeof options === 'boolean' ? { allowSsh: options } : options;
    this.#allowSsh = resolved.allowSsh === true;
    this.#allowWrite = resolved.allowWrite === true;
    this.#boundaryProbe = resolved.boundaryProbe;
    this.#manifest = validateGatewayManifest(manifest);
  }

  get manifestVersion(): number {
    return this.#manifest.version;
  }

  replaceManifest(manifest: GatewayManifest): void {
    this.#manifest = validateGatewayManifest(manifest);
  }

  listAliases(ownerUserId: string): WorkspaceAlias[] {
    return this.#manifest.grants
      .filter((grant) => grant.enabled && grant.kind === 'local' && grant.ownerUserId === ownerUserId)
      .map(({ workspaceId, access, label }) => ({ workspaceId, access, label }));
  }

  admit(claims: GatewayAssertionClaims, requestedManifestVersion = this.#manifest.version): SessionBinding {
    if (claims.purpose !== 'session_create') throw new WorkspaceAdmissionError('workspace_not_found');
    if (requestedManifestVersion !== this.#manifest.version)
      throw new WorkspaceAdmissionError('manifest_version_mismatch');
    const workspaceId = claims.workspaceId;
    if (!workspaceId) throw new WorkspaceAdmissionError('workspace_not_found');
    const grant = this.#manifest.grants.find((candidate) => candidate.workspaceId === workspaceId);
    if (!grant) throw new WorkspaceAdmissionError('workspace_not_found');
    if (grant.ownerUserId !== claims.sub) throw new WorkspaceAdmissionError('workspace_owner_mismatch');
    if ([...this.#sessions.values()].some((session) => session.workspaceId === workspaceId)) {
      throw new WorkspaceAdmissionError('workspace_session_exists');
    }
    if (!grant.enabled) throw new WorkspaceAdmissionError('workspace_disabled');
    if (grant.kind === 'ssh') {
      if (!this.#allowSsh) throw new WorkspaceAdmissionError('ssh_disabled');
      throw new WorkspaceAdmissionError('ssh_disabled');
    }
    const canonicalRoot = canonicalizeGrantRoot(grant);
    const boundary = this.#boundaryProbe?.(canonicalRoot, grant.access);
    if (!boundary || boundary.mountedRoot !== canonicalRoot) {
      throw new WorkspaceAdmissionError('workspace_boundary_unverified');
    }
    if (grant.access === 'read_write' && (!this.#allowWrite || !boundary.writable)) {
      throw new WorkspaceAdmissionError('write_not_allowed');
    }
    if (grant.access === 'read' && boundary.writable) {
      throw new WorkspaceAdmissionError('workspace_boundary_unverified');
    }
    const binding: SessionBinding = {
      sessionId: randomUUID(),
      ownerUserId: claims.sub,
      workspaceId: grant.workspaceId,
      grantVersion: this.#manifest.version,
      canonicalRoot,
      access: grant.access,
    };
    this.#sessions.set(binding.sessionId, binding);
    return Object.freeze(binding);
  }

  /**
   * Reconstruct an immutable binding from the gateway-owned session index after
   * a daemon restart. The index supplies only opaque identity/version fields;
   * the manifest and boundary probe remain the authority for the root.
   */
  restore(sessionId: string, ownerUserId: string, workspaceId: string, grantVersion: number): SessionBinding {
    const current = this.#sessions.get(sessionId);
    if (current) {
      if (current.ownerUserId !== ownerUserId || current.workspaceId !== workspaceId)
        throw new WorkspaceAdmissionError('session_owner_mismatch');
      if (current.grantVersion !== grantVersion) throw new WorkspaceAdmissionError('manifest_version_mismatch');
      return current;
    }
    if (grantVersion !== this.#manifest.version) throw new WorkspaceAdmissionError('manifest_version_mismatch');
    const grant = this.#manifest.grants.find((candidate) => candidate.workspaceId === workspaceId);
    if (!grant) throw new WorkspaceAdmissionError('workspace_not_found');
    if (grant.ownerUserId !== ownerUserId) throw new WorkspaceAdmissionError('workspace_owner_mismatch');
    if (!grant.enabled) throw new WorkspaceAdmissionError('workspace_disabled');
    if (grant.kind === 'ssh' || !grant.localRoot) throw new WorkspaceAdmissionError('ssh_disabled');
    const canonicalRoot = canonicalizeGrantRoot(grant);
    const boundary = this.#boundaryProbe?.(canonicalRoot, grant.access);
    if (!boundary || boundary.mountedRoot !== canonicalRoot)
      throw new WorkspaceAdmissionError('workspace_boundary_unverified');
    if (grant.access === 'read_write' && (!this.#allowWrite || !boundary.writable))
      throw new WorkspaceAdmissionError('write_not_allowed');
    if (grant.access === 'read' && boundary.writable)
      throw new WorkspaceAdmissionError('workspace_boundary_unverified');
    const binding: SessionBinding = {
      sessionId,
      ownerUserId,
      workspaceId: grant.workspaceId,
      grantVersion: this.#manifest.version,
      canonicalRoot,
      access: grant.access,
    };
    this.#sessions.set(sessionId, binding);
    return Object.freeze(binding);
  }

  getSession(sessionId: string, ownerUserId: string): SessionBinding {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new WorkspaceAdmissionError('session_not_found');
    if (session.ownerUserId !== ownerUserId) throw new WorkspaceAdmissionError('session_owner_mismatch');
    return session;
  }

  assertSessionWorkspace(sessionId: string, ownerUserId: string, workspaceId: string): SessionBinding {
    const session = this.getSession(sessionId, ownerUserId);
    if (session.workspaceId !== workspaceId) throw new WorkspaceAdmissionError('session_owner_mismatch');
    return session;
  }

  retarget(): never {
    throw new WorkspaceAdmissionError('session_retarget_forbidden');
  }

  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  static assertPath(binding: SessionBinding, requestedPath: string): string {
    if (!requestedPath || requestedPath.includes('\u0000') || path.isAbsolute(requestedPath)) {
      throw new WorkspaceAdmissionError('workspace_path_escape');
    }
    const parts = requestedPath.split(/[\\/]+/);
    if (parts.includes('..')) throw new WorkspaceAdmissionError('workspace_path_escape');
    const candidate = path.resolve(binding.canonicalRoot, requestedPath);
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      throw new WorkspaceAdmissionError('workspace_path_escape');
    }
    if (!isContained(binding.canonicalRoot, resolved)) throw new WorkspaceAdmissionError('workspace_path_escape');
    return resolved;
  }
}

function canonicalizeGrantRoot(grant: WorkspaceGrant): string {
  if (!grant.localRoot) throw new WorkspaceAdmissionError('workspace_root_unavailable');
  let actual: string;
  try {
    actual = realpathSync(grant.localRoot);
    if (!statSync(actual).isDirectory()) throw new Error();
  } catch {
    throw new WorkspaceAdmissionError('workspace_root_unavailable');
  }
  if (actual !== path.resolve(grant.localRoot)) throw new WorkspaceAdmissionError('workspace_root_not_canonical');
  return actual;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isProvisionedLabel(value: string): boolean {
  return value.length > 0 && value.length <= 120 && value === value.trim() && !/[\u0000\r\n]/.test(value);
}
