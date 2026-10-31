import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { DirectHostConfigError } from './direct-host-config-error.js';
import { contained, isOpaqueId, opaqueId } from './direct-host-config-workspace-grants.js';
import type { WorkspaceAccess } from './direct-host-config-workspace-grants.js';

export type WorkspaceCheck = {
  name: 'absolute' | 'exists' | 'directory' | 'readable' | 'canonical' | 'contained';
  status: 'ok' | 'error';
};
export type CandidateValidation =
  | { valid: true; candidateId: string; displayName: string; expiresAt: number; checks: readonly WorkspaceCheck[] }
  | { valid: false; checks: readonly WorkspaceCheck[]; reasonCode: string; reason: string };
export type CandidateBrowse = {
  candidateId: string;
  entries: readonly {
    name: string;
    type: 'directory' | 'file' | 'symlink' | 'other';
    selectable: boolean;
    rejectionReason?: string;
    targetDisplay?: string;
    childToken?: string;
  }[];
  truncated: boolean;
};

const TTL_MS = 5 * 60_000;
const MAX_CANDIDATES = 128;
const MAX_PER_OWNER = 16;
const MAX_REGISTRY = MAX_CANDIDATES * 8;
const MAX_BROWSE = 256;

type Candidate = {
  candidateId: string;
  ownerUserId: string;
  canonicalRoot: string;
  displayName: string;
  expiresAt: number;
};
type Token = { candidateId: string; ownerUserId: string; canonicalPath: string; expiresAt: number; createdAt: number };

/** Ephemeral candidate discovery. Grants are a separate authority and are not created here. */
export class DirectCandidateRegistry {
  readonly #roots: readonly string[];
  readonly #now: () => number;
  readonly #candidates = new Map<string, Candidate>();
  readonly #tokens = new Map<string, Token>();

  constructor(allowedRoots: readonly string[], now: () => number = Date.now) {
    this.#roots = allowedRoots;
    this.#now = now;
  }

  validate(ownerUserId: string, absolutePath: string): CandidateValidation {
    const checks: WorkspaceCheck[] = [];
    const fail = (reasonCode: string, reason: string): CandidateValidation => ({
      valid: false,
      checks: [...checks],
      reasonCode,
      reason,
    });
    if (!absolutePath || absolutePath.includes('\0'))
      return fail('workspace_root_unavailable', 'The workspace path is invalid.');
    if (!path.isAbsolute(absolutePath)) {
      checks.push({ name: 'absolute', status: 'error' });
      return fail('workspace_root_unavailable', 'The workspace path must be absolute.');
    }
    checks.push({ name: 'absolute', status: 'ok' });
    try {
      if (!statSync(absolutePath).isDirectory()) {
        checks.push({ name: 'exists', status: 'ok' }, { name: 'directory', status: 'error' });
        return fail('workspace_root_unavailable', 'The selected path is not a directory.');
      }
      checks.push({ name: 'exists', status: 'ok' }, { name: 'directory', status: 'ok' });
    } catch {
      checks.push({ name: 'exists', status: 'error' });
      return fail('workspace_root_unavailable', 'The workspace folder is unavailable.');
    }
    let canonical: string;
    try {
      canonical = realpathSync(absolutePath);
      checks.push({ name: 'canonical', status: 'ok' });
    } catch {
      checks.push({ name: 'canonical', status: 'error' });
      return fail('workspace_root_not_canonical', 'The workspace path could not be canonicalized.');
    }
    try {
      accessSync(canonical, constants.R_OK | constants.X_OK);
      checks.push({ name: 'readable', status: 'ok' });
    } catch {
      checks.push({ name: 'readable', status: 'error' });
      return fail('workspace_not_readable', 'The local user cannot read this folder.');
    }
    if (!this.#roots.some((root) => contained(root, canonical))) {
      checks.push({ name: 'contained', status: 'error' });
      return fail('workspace_path_escape', 'The selected folder is outside the allowed workspace roots.');
    }
    checks.push({ name: 'contained', status: 'ok' });
    this.#prune();
    const owned = [...this.#candidates.values()].filter((candidate) => candidate.ownerUserId === ownerUserId).length;
    if (this.#candidates.size >= MAX_CANDIDATES || owned >= MAX_PER_OWNER || this.#size() >= MAX_REGISTRY) {
      return fail('candidate_registry_full', 'Too many workspace selections are pending.');
    }
    const candidateId = opaqueId();
    const record: Candidate = {
      candidateId,
      ownerUserId,
      canonicalRoot: canonical,
      displayName: path.basename(canonical) || canonical,
      expiresAt: this.#now() + TTL_MS,
    };
    this.#candidates.set(candidateId, record);
    return { valid: true, candidateId, displayName: record.displayName, expiresAt: record.expiresAt, checks };
  }

  browse(ownerUserId: string, candidateId: string, child?: string): CandidateBrowse {
    const candidate = this.#candidate(candidateId, ownerUserId);
    const parent = child ? this.#child(child, candidate) : this.#revalidate(candidate);
    this.#readable(parent);
    let entries: CandidateBrowse['entries'][number][];
    try {
      entries = readdirSync(parent, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => this.#entry(candidate, parent, entry));
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      throw new DirectHostConfigError('workspace_not_readable', 'candidate');
    }
    return { candidateId, entries: entries.slice(0, MAX_BROWSE), truncated: entries.length > MAX_BROWSE };
  }

  /** Revalidate and drop the candidate if the directory can no longer be admitted. */
  take(ownerUserId: string, candidateId: string): { canonicalRoot: string; displayName: string } {
    const candidate = this.#candidate(candidateId, ownerUserId);
    try {
      return { canonicalRoot: this.#revalidate(candidate), displayName: candidate.displayName };
    } catch (error) {
      this.expire(candidateId);
      throw error;
    }
  }

  expire(candidateId: string): void {
    this.#candidates.delete(candidateId);
    for (const [token, value] of this.#tokens) if (value.candidateId === candidateId) this.#tokens.delete(token);
  }

  #candidate(candidateId: string, ownerUserId: string): Candidate {
    if (!isOpaqueId(candidateId)) throw new DirectHostConfigError('candidate_not_found', 'candidate');
    const candidate = this.#candidates.get(candidateId);
    if (!candidate) throw new DirectHostConfigError('candidate_not_found', 'candidate');
    if (candidate.ownerUserId !== ownerUserId) throw new DirectHostConfigError('workspace_owner_mismatch', 'candidate');
    if (candidate.expiresAt <= this.#now()) {
      this.expire(candidateId);
      throw new DirectHostConfigError('candidate_expired', 'candidate');
    }
    this.#prune();
    return candidate;
  }

  #revalidate(candidate: Candidate): string {
    let canonical: string;
    try {
      canonical = realpathSync(candidate.canonicalRoot);
      if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
      accessSync(canonical, constants.R_OK | constants.X_OK);
    } catch {
      throw new DirectHostConfigError('workspace_root_unavailable', 'candidate');
    }
    if (canonical !== candidate.canonicalRoot || !this.#roots.some((root) => contained(root, canonical))) {
      throw new DirectHostConfigError('workspace_path_escape', 'candidate');
    }
    return canonical;
  }

  #child(token: string, candidate: Candidate): string {
    if (!isOpaqueId(token)) throw new DirectHostConfigError('candidate_not_found', 'candidate');
    const value = this.#tokens.get(token);
    if (!value || value.candidateId !== candidate.candidateId || value.ownerUserId !== candidate.ownerUserId) {
      throw new DirectHostConfigError('candidate_not_found', 'candidate');
    }
    if (value.expiresAt <= this.#now()) {
      this.#tokens.delete(token);
      throw new DirectHostConfigError('candidate_expired', 'candidate');
    }
    const root = this.#revalidate(candidate);
    let current: string;
    try {
      current = realpathSync(value.canonicalPath);
    } catch {
      this.#tokens.delete(token);
      throw new DirectHostConfigError('workspace_path_escape', 'candidate');
    }
    if (current !== value.canonicalPath || !contained(root, current)) {
      this.#tokens.delete(token);
      throw new DirectHostConfigError('workspace_path_escape', 'candidate');
    }
    this.#readable(current);
    return current;
  }

  #entry(candidate: Candidate, parent: string, entry: Dirent): CandidateBrowse['entries'][number] {
    const fullPath = path.join(parent, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory())
      return this.#directory(candidate, fullPath, entry.name, entry.isSymbolicLink() ? 'symlink' : 'directory');
    return {
      name: entry.name,
      type: entry.isFile() ? 'file' : 'other',
      selectable: false,
      rejectionReason: 'workspace_not_directory',
    };
  }

  #directory(
    candidate: Candidate,
    fullPath: string,
    name: string,
    type: 'directory' | 'symlink',
  ): CandidateBrowse['entries'][number] {
    try {
      const target = realpathSync(fullPath);
      if (!contained(candidate.canonicalRoot, target)) {
        return {
          name,
          type,
          selectable: false,
          rejectionReason: 'workspace_path_escape',
          ...(type === 'symlink' ? { targetDisplay: 'outside-candidate-root' } : {}),
        };
      }
      if (!statSync(target).isDirectory())
        return { name, type, selectable: false, rejectionReason: 'workspace_not_directory' };
      const childToken = this.#token(candidate, target);
      return {
        name,
        type,
        selectable: true,
        ...(type === 'symlink' ? { targetDisplay: path.relative(candidate.canonicalRoot, target) || '.' } : {}),
        ...(childToken ? { childToken } : {}),
      };
    } catch {
      return { name, type, selectable: false, rejectionReason: 'workspace_root_unavailable' };
    }
  }

  #token(candidate: Candidate, directory: string): string | undefined {
    this.#prune();
    if (this.#size() >= MAX_REGISTRY) {
      let oldest: [string, Token] | undefined;
      for (const item of this.#tokens) if (!oldest || item[1].createdAt < oldest[1].createdAt) oldest = item;
      if (oldest) this.#tokens.delete(oldest[0]);
      if (this.#size() >= MAX_REGISTRY) return undefined;
    }
    const token = opaqueId();
    const now = this.#now();
    this.#tokens.set(token, {
      candidateId: candidate.candidateId,
      ownerUserId: candidate.ownerUserId,
      canonicalPath: directory,
      expiresAt: Math.min(candidate.expiresAt, now + TTL_MS),
      createdAt: now,
    });
    return token;
  }

  #readable(root: string): void {
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
      accessSync(root, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      throw new DirectHostConfigError('workspace_not_readable', 'candidate');
    }
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, candidate] of this.#candidates) if (candidate.expiresAt <= now) this.expire(id);
    for (const [token, browse] of this.#tokens) {
      if (browse.expiresAt <= now || !this.#candidates.has(browse.candidateId)) this.#tokens.delete(token);
    }
  }

  #size(): number {
    return this.#candidates.size + this.#tokens.size;
  }
}

export type { WorkspaceAccess };
