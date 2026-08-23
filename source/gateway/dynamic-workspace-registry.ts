import { constants, accessSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionContext } from '../services/execution-context.js';
import type { SessionBinding, WorkspaceGrant } from './contracts.js';
import { WorkspaceAdmission, WorkspaceAdmissionError } from './workspace-admission.js';

export type WorkspaceValidationCheck = {
  name: 'absolute' | 'exists' | 'directory' | 'readable' | 'canonical' | 'contained';
  status: 'ok' | 'error' | 'pending';
};

export type WorkspaceCandidateValidation =
  | {
      valid: true;
      candidateId: string;
      displayName: string;
      expiresAt: number;
      checks: readonly WorkspaceValidationCheck[];
    }
  | {
      valid: false;
      checks: readonly WorkspaceValidationCheck[];
      reasonCode:
        | 'workspace_root_unavailable'
        | 'workspace_root_not_canonical'
        | 'workspace_path_escape'
        | 'workspace_not_readable'
        | 'candidate_registry_full';
      reason: string;
    };

type CandidateFailureCode =
  | 'workspace_root_unavailable'
  | 'workspace_root_not_canonical'
  | 'workspace_path_escape'
  | 'workspace_not_readable'
  | 'candidate_registry_full';

export type WorkspaceBrowseEntry = {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  selectable: boolean;
  rejectionReason?: 'workspace_path_escape' | 'workspace_root_unavailable' | 'workspace_not_directory';
  targetDisplay?: string;
  childToken?: string;
};

export type WorkspaceBrowseResult = {
  candidateId: string;
  entries: readonly WorkspaceBrowseEntry[];
  truncated: boolean;
};

export type DynamicWorkspaceRegistryFs = {
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean };
  accessSync(path: string, mode: number): void;
  readdirSync(path: string, options: { withFileTypes: true }): import('node:fs').Dirent[];
};

export type DynamicWorkspaceSelection = {
  workspaceId: string;
  displayName: string;
  binding: SessionBinding;
};

export class DynamicWorkspaceRegistryError extends Error {
  readonly code:
    | 'candidate_not_found'
    | 'candidate_expired'
    | 'workspace_owner_mismatch'
    | 'workspace_root_unavailable'
    | 'workspace_not_readable'
    | 'workspace_not_directory'
    | 'workspace_path_escape'
    | 'candidate_registry_full';

  constructor(code: DynamicWorkspaceRegistryError['code']) {
    super('dynamic workspace registry rejected the request');
    this.name = 'DynamicWorkspaceRegistryError';
    this.code = code;
  }
}

type CandidateRecord = {
  candidateId: string;
  ownerUserId: string;
  canonicalRoot: string;
  displayName: string;
  expiresAt: number;
};

type BrowseToken = {
  candidateId: string;
  ownerUserId: string;
  canonicalPath: string;
  expiresAt: number;
  createdAt: number;
};

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_CANDIDATES_PER_OWNER = 16;
const DEFAULT_MAX_BROWSE_ENTRIES = 256;

export class DynamicWorkspaceRegistry {
  readonly #admission: WorkspaceAdmission;
  readonly #allowedRoots: readonly string[];
  readonly #candidateTtlMs: number;
  readonly #maxCandidates: number;
  readonly #maxCandidatesPerOwner: number;
  readonly #maxRegistryEntries: number;
  readonly #browseTokenTtlMs: number;
  readonly #maxBrowseEntries: number;
  readonly #now: () => number;
  readonly #fs: DynamicWorkspaceRegistryFs;
  readonly #candidates = new Map<string, CandidateRecord>();
  readonly #browseTokens = new Map<string, BrowseToken>();

  constructor(options: {
    admission: WorkspaceAdmission;
    allowedRoots: readonly string[];
    candidateTtlMs?: number;
    maxCandidates?: number;
    maxCandidatesPerOwner?: number;
    /** Total candidate + browse-token budget. Tokens are not unbounded side state. */
    maxRegistryEntries?: number;
    browseTokenTtlMs?: number;
    maxBrowseEntries?: number;
    now?: () => number;
    fs?: DynamicWorkspaceRegistryFs;
  }) {
    this.#admission = options.admission;
    this.#allowedRoots = Object.freeze(options.allowedRoots.map((root) => canonicalRoot(root)));
    this.#candidateTtlMs = positiveBound(options.candidateTtlMs ?? DEFAULT_TTL_MS, 'candidateTtlMs');
    this.#maxCandidates = positiveBound(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 'maxCandidates');
    this.#maxCandidatesPerOwner = positiveBound(
      options.maxCandidatesPerOwner ?? Math.min(DEFAULT_MAX_CANDIDATES_PER_OWNER, this.#maxCandidates),
      'maxCandidatesPerOwner',
    );
    this.#maxRegistryEntries = positiveBound(
      options.maxRegistryEntries ?? Math.max(this.#maxCandidates, this.#maxCandidates * 8),
      'maxRegistryEntries',
    );
    this.#browseTokenTtlMs = positiveBound(options.browseTokenTtlMs ?? this.#candidateTtlMs, 'browseTokenTtlMs');
    this.#maxBrowseEntries = positiveBound(options.maxBrowseEntries ?? DEFAULT_MAX_BROWSE_ENTRIES, 'maxBrowseEntries');
    this.#now = options.now ?? Date.now;
    this.#fs = options.fs ?? { realpathSync, statSync, accessSync, readdirSync };
  }

  get admission(): WorkspaceAdmission {
    return this.#admission;
  }

  get candidateCount(): number {
    this.#pruneExpired();
    return this.#candidates.size;
  }

  get browseTokenCount(): number {
    this.#pruneExpired();
    return this.#browseTokens.size;
  }

  validateCandidate(candidatePath: string, ownerUserId = 'local-owner'): WorkspaceCandidateValidation {
    const checks: WorkspaceValidationCheck[] = [];
    if (!ownerUserId || typeof candidatePath !== 'string' || !candidatePath || candidatePath.includes('\u0000')) {
      return invalid(checks, 'workspace_root_unavailable', 'The workspace path is invalid.');
    }
    if (!path.isAbsolute(candidatePath)) {
      checks.push({ name: 'absolute', status: 'error' });
      return invalid(checks, 'workspace_root_unavailable', 'The workspace path must be absolute.');
    }
    checks.push({ name: 'absolute', status: 'ok' });

    let canonical: string;
    try {
      const initialStat = this.#fs.statSync(candidatePath);
      checks.push({ name: 'exists', status: 'ok' });
      if (!initialStat.isDirectory()) {
        checks.push({ name: 'directory', status: 'error' });
        return invalid(checks, 'workspace_root_unavailable', 'The selected path is not a directory.');
      }
      checks.push({ name: 'directory', status: 'ok' });
    } catch {
      checks.push({ name: 'exists', status: 'error' });
      return invalid(checks, 'workspace_root_unavailable', 'The workspace folder is unavailable.');
    }
    try {
      canonical = this.#fs.realpathSync(candidatePath);
      checks.push({ name: 'canonical', status: 'ok' });
    } catch {
      checks.push({ name: 'canonical', status: 'error' });
      return invalid(checks, 'workspace_root_not_canonical', 'The workspace path could not be canonicalized.');
    }
    try {
      this.#fs.accessSync(canonical, constants.R_OK | constants.X_OK);
      checks.push({ name: 'readable', status: 'ok' });
    } catch {
      checks.push({ name: 'readable', status: 'error' });
      return invalid(checks, 'workspace_not_readable', 'The local user cannot read this folder.');
    }

    if (!this.#isContainedByAllowedRoot(canonical)) {
      checks.push({ name: 'contained', status: 'error' });
      return invalid(checks, 'workspace_path_escape', 'The selected folder is outside the allowed workspace roots.');
    }
    checks.push({ name: 'contained', status: 'ok' });
    this.#pruneExpired();
    const ownerCandidates = [...this.#candidates.values()].filter((candidate) => candidate.ownerUserId === ownerUserId);
    if (
      this.#candidates.size >= this.#maxCandidates ||
      ownerCandidates.length >= this.#maxCandidatesPerOwner ||
      this.#registryEntryCount() >= this.#maxRegistryEntries
    ) {
      return invalid(checks, 'candidate_registry_full', 'Too many workspace selections are pending.');
    }
    const candidateId = opaqueId();
    const record: CandidateRecord = {
      candidateId,
      ownerUserId,
      canonicalRoot: canonical,
      displayName: path.basename(canonical) || canonical,
      expiresAt: this.#now() + this.#candidateTtlMs,
    };
    this.#candidates.set(candidateId, record);
    return {
      valid: true,
      candidateId,
      displayName: record.displayName,
      expiresAt: record.expiresAt,
      checks,
    };
  }

  browse(candidateId: string, childToken?: string, ownerUserId = 'local-owner'): WorkspaceBrowseResult {
    const candidate = this.#candidateFor(candidateId, ownerUserId);
    const parent = childToken ? this.#browsePath(childToken, candidate) : this.#revalidate(candidate);
    this.#assertReadableDirectory(parent);
    let entries: WorkspaceBrowseEntry[];
    try {
      entries = this.#fs
        .readdirSync(parent, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => this.#browseEntry(candidate, parent, entry));
    } catch {
      throw new DynamicWorkspaceRegistryError('workspace_not_readable');
    }
    return {
      candidateId,
      entries: entries.slice(0, this.#maxBrowseEntries),
      truncated: entries.length > this.#maxBrowseEntries,
    };
  }

  select(candidateId: string, access: 'read' | 'read_write', ownerUserId = 'local-owner'): DynamicWorkspaceSelection {
    if (access !== 'read' && access !== 'read_write')
      throw new DynamicWorkspaceRegistryError('workspace_root_unavailable');
    const candidate = this.#candidateFor(candidateId, ownerUserId);
    let canonical: string;
    try {
      canonical = this.#revalidate(candidate);
    } catch (error) {
      this.expire(candidateId);
      throw error;
    }
    const workspaceId = `ws_${opaqueId()}`;
    const grant: WorkspaceGrant = {
      workspaceId,
      ownerUserId,
      label: candidate.displayName,
      kind: 'local',
      localRoot: canonical,
      access,
      enabled: true,
    };
    this.#admission.registerDynamicLocalGrant(grant);
    try {
      const binding = this.#admission.prepare({
        iss: 'term2-local-owner',
        aud: 'term2-local-owner',
        sub: ownerUserId,
        purpose: 'session_create',
        iat: 0,
        nbf: 0,
        exp: Number.MAX_SAFE_INTEGER,
        jti: opaqueId(),
        ver: 1,
        workspaceId,
      });
      this.#candidates.delete(candidateId);
      for (const [token, value] of this.#browseTokens) {
        if (value.candidateId === candidateId) this.#browseTokens.delete(token);
      }
      return { workspaceId, displayName: candidate.displayName, binding };
    } catch (error) {
      this.#admission.removeDynamicLocalGrant(workspaceId);
      if (error instanceof WorkspaceAdmissionError) throw error;
      throw new DynamicWorkspaceRegistryError('workspace_root_unavailable');
    }
  }

  expire(candidateId: string): void {
    this.#candidates.delete(candidateId);
    for (const [token, value] of this.#browseTokens) {
      if (value.candidateId === candidateId) this.#browseTokens.delete(token);
    }
  }

  pin(binding: SessionBinding): ExecutionContext {
    return ExecutionContext.pin(binding.canonicalRoot);
  }

  #candidateFor(candidateId: string, ownerUserId: string): CandidateRecord {
    if (!OPAQUE_ID.test(candidateId)) throw new DynamicWorkspaceRegistryError('candidate_not_found');
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) throw new DynamicWorkspaceRegistryError('candidate_not_found');
    if (candidate.ownerUserId !== ownerUserId) throw new DynamicWorkspaceRegistryError('workspace_owner_mismatch');
    if (candidate.expiresAt <= this.#now()) {
      this.expire(candidateId);
      throw new DynamicWorkspaceRegistryError('candidate_expired');
    }
    this.#pruneExpired();
    return candidate;
  }

  #browsePath(token: string, candidate: CandidateRecord): string {
    if (!OPAQUE_ID.test(token)) throw new DynamicWorkspaceRegistryError('candidate_not_found');
    const value = this.#browseTokens.get(token);
    if (!value || value.candidateId !== candidate.candidateId || value.ownerUserId !== candidate.ownerUserId)
      throw new DynamicWorkspaceRegistryError('candidate_not_found');
    if (value.expiresAt <= this.#now()) {
      this.#browseTokens.delete(token);
      throw new DynamicWorkspaceRegistryError('candidate_expired');
    }
    let canonical: string;
    try {
      canonical = this.#revalidate(candidate);
    } catch (error) {
      this.#browseTokens.delete(token);
      throw error;
    }
    let currentPath: string;
    try {
      currentPath = this.#fs.realpathSync(value.canonicalPath);
    } catch {
      this.#browseTokens.delete(token);
      throw new DynamicWorkspaceRegistryError('workspace_path_escape');
    }
    if (currentPath !== value.canonicalPath || !isContained(canonical, currentPath)) {
      this.#browseTokens.delete(token);
      throw new DynamicWorkspaceRegistryError('workspace_path_escape');
    }
    this.#assertReadableDirectory(currentPath);
    return currentPath;
  }

  #browseEntry(candidate: CandidateRecord, parent: string, entry: import('node:fs').Dirent): WorkspaceBrowseEntry {
    const fullPath = path.join(parent, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = this.#fs.realpathSync(fullPath);
        const inside = isContained(candidate.canonicalRoot, target);
        if (!inside) {
          return {
            name: entry.name,
            type: 'symlink',
            selectable: false,
            rejectionReason: 'workspace_path_escape',
            targetDisplay: 'outside-candidate-root',
          };
        }
        if (!this.#fs.statSync(target).isDirectory()) {
          return { name: entry.name, type: 'symlink', selectable: false, rejectionReason: 'workspace_not_directory' };
        }
        return {
          name: entry.name,
          type: 'symlink',
          selectable: true,
          targetDisplay: path.relative(candidate.canonicalRoot, target) || '.',
          childToken: this.#tokenFor(candidate, target),
        };
      } catch {
        return { name: entry.name, type: 'symlink', selectable: false, rejectionReason: 'workspace_root_unavailable' };
      }
    }
    if (entry.isDirectory()) {
      try {
        const target = this.#fs.realpathSync(fullPath);
        if (!isContained(candidate.canonicalRoot, target))
          return { name: entry.name, type: 'directory', selectable: false, rejectionReason: 'workspace_path_escape' };
        if (!this.#fs.statSync(target).isDirectory())
          return { name: entry.name, type: 'directory', selectable: false, rejectionReason: 'workspace_not_directory' };
        return { name: entry.name, type: 'directory', selectable: true, childToken: this.#tokenFor(candidate, target) };
      } catch {
        return {
          name: entry.name,
          type: 'directory',
          selectable: false,
          rejectionReason: 'workspace_root_unavailable',
        };
      }
    }
    if (entry.isFile())
      return { name: entry.name, type: 'file', selectable: false, rejectionReason: 'workspace_not_directory' };
    return { name: entry.name, type: 'other', selectable: false, rejectionReason: 'workspace_not_directory' };
  }

  #tokenFor(candidate: CandidateRecord, directory: string): string | undefined {
    this.#pruneExpired();
    if (this.#registryEntryCount() >= this.#maxRegistryEntries) {
      this.#evictBrowseToken();
      if (this.#registryEntryCount() >= this.#maxRegistryEntries) return undefined;
    }
    const token = opaqueId();
    const now = this.#now();
    this.#browseTokens.set(token, {
      candidateId: candidate.candidateId,
      ownerUserId: candidate.ownerUserId,
      canonicalPath: directory,
      expiresAt: Math.min(candidate.expiresAt, now + this.#browseTokenTtlMs),
      createdAt: now,
    });
    return token;
  }

  #revalidate(candidate: CandidateRecord): string {
    let canonical: string;
    try {
      canonical = this.#fs.realpathSync(candidate.canonicalRoot);
      if (!this.#fs.statSync(canonical).isDirectory()) throw new Error();
      this.#fs.accessSync(canonical, constants.R_OK | constants.X_OK);
    } catch {
      throw new DynamicWorkspaceRegistryError('workspace_root_unavailable');
    }
    if (canonical !== candidate.canonicalRoot || !this.#isContainedByAllowedRoot(canonical)) {
      throw new DynamicWorkspaceRegistryError('workspace_path_escape');
    }
    return canonical;
  }

  #assertReadableDirectory(directory: string): void {
    try {
      if (!this.#fs.statSync(directory).isDirectory()) throw new Error();
      this.#fs.accessSync(directory, constants.R_OK | constants.X_OK);
    } catch {
      throw new DynamicWorkspaceRegistryError('workspace_not_readable');
    }
  }

  #isContainedByAllowedRoot(candidate: string): boolean {
    return this.#allowedRoots.some((root) => isContained(root, candidate));
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, candidate] of this.#candidates) {
      if (candidate.expiresAt <= now) this.expire(id);
    }
    for (const [token, browse] of this.#browseTokens) {
      if (browse.expiresAt <= now || !this.#candidates.has(browse.candidateId)) this.#browseTokens.delete(token);
    }
  }

  #registryEntryCount(): number {
    return this.#candidates.size + this.#browseTokens.size;
  }

  #evictBrowseToken(): void {
    let oldest: [string, BrowseToken] | undefined;
    for (const item of this.#browseTokens.entries()) {
      if (!oldest || item[1].createdAt < oldest[1].createdAt) oldest = item;
    }
    if (oldest) this.#browseTokens.delete(oldest[0]);
  }
}

function canonicalRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('dynamic workspace allowed roots must be absolute');
  try {
    const resolved = realpathSync(root);
    if (!statSync(resolved).isDirectory()) throw new Error();
    return resolved;
  } catch {
    throw new Error('dynamic workspace allowed root is unavailable');
  }
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function opaqueId(): string {
  return randomUUID().replaceAll('-', '');
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function invalid(
  checks: readonly WorkspaceValidationCheck[],
  reasonCode: CandidateFailureCode,
  reason: string,
): WorkspaceCandidateValidation {
  return { valid: false, checks, reasonCode, reason };
}
