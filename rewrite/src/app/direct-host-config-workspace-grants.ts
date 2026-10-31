import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DirectHostConfigError } from './direct-host-config-error.js';

export type WorkspaceAccess = 'read' | 'read_write';

/** Durable local grant. Dynamic grants are the only ones written to the direct grant file. */
export type GrantRecord = {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly label: string;
  readonly root: string;
  readonly access: WorkspaceAccess;
  readonly grantVersion: number;
  readonly dynamic: boolean;
};

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const FILE_NAME = 'direct-workspace-grants.json';

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

export function opaqueId(): string {
  return randomUUID().replaceAll('-', '');
}

export function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Startup path: must already be a real directory. Does not follow a non-canonical alias. */
export function requireCanonicalDirectory(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  try {
    const actual = realpathSync(root);
    if (!statSync(actual).isDirectory() || actual !== path.resolve(root)) throw new Error('not canonical');
    return actual;
  } catch (error) {
    if (error instanceof DirectHostConfigError) throw error;
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
}

/** Use-time path. A symlink, missing directory, or non-canonical spelling is not authority. */
export function canonicalizeUse(root: string): string {
  if (!root || root.includes('\0') || !path.isAbsolute(root)) {
    throw new DirectHostConfigError('workspace_root_unavailable', 'authority');
  }
  try {
    const actual = realpathSync(root);
    if (!statSync(actual).isDirectory()) throw new Error('not a directory');
    if (actual !== path.resolve(root)) throw new DirectHostConfigError('workspace_root_not_canonical', 'authority');
    return actual;
  } catch (error) {
    if (error instanceof DirectHostConfigError) throw error;
    throw new DirectHostConfigError('workspace_root_unavailable', 'authority');
  }
}

export function requireStateDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || directory.includes('\0')) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!statSync(directory).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    if (error instanceof DirectHostConfigError) throw error;
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  return directory;
}

export function loadDynamicGrants(directory: string): GrantRecord[] {
  const file = path.join(directory, FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  const body = parsed as Record<string, unknown>;
  if (body.version !== 1 || !Array.isArray(body.grants))
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  return body.grants.map(parseGrant);
}

export function saveDynamicGrants(directory: string, grants: readonly GrantRecord[]): void {
  const file = path.join(directory, FILE_NAME);
  const temp = `${file}.${process.pid}.tmp`;
  const body = {
    version: 1,
    grants: grants.filter((grant) => grant.dynamic).map(persisted),
  };
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* The temp file may not exist. */
    }
    throw error;
  }
}

/** A missing restored directory is kept and denied at use. A retargeted path fails closed. */
export function inspectRestoredRoot(root: string): void {
  if (!path.isAbsolute(root) || root.includes('\0'))
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  try {
    const actual = realpathSync(root);
    if (!statSync(actual).isDirectory() || actual !== path.resolve(root)) {
      throw new DirectHostConfigError('configuration_invalid', 'startup');
    }
  } catch (error) {
    if (error instanceof DirectHostConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
}

export function grantFromInput(value: {
  readonly workspaceId: unknown;
  readonly ownerUserId: unknown;
  readonly label: unknown;
  readonly root: string;
  readonly access: unknown;
  readonly grantVersion: number;
  readonly dynamic: boolean;
}): GrantRecord {
  if (!isOpaqueId(value.workspaceId) || !isOwner(value.ownerUserId) || !isLabel(value.label)) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  if (!path.isAbsolute(value.root) || value.root.includes('\0')) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  if (
    (value.access !== 'read' && value.access !== 'read_write') ||
    !Number.isSafeInteger(value.grantVersion) ||
    value.grantVersion < 1
  ) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  return {
    workspaceId: value.workspaceId,
    ownerUserId: value.ownerUserId,
    label: value.label,
    root: value.root,
    access: value.access,
    grantVersion: value.grantVersion,
    dynamic: value.dynamic,
  };
}

function parseGrant(value: unknown): GrantRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  const record = value as Record<string, unknown>;
  const allowed = ['workspaceId', 'ownerUserId', 'label', 'root', 'access', 'grantVersion'];
  if (!Object.keys(record).every((key) => allowed.includes(key)) || typeof record.root !== 'string') {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  if (!Number.isSafeInteger(record.grantVersion)) throw new DirectHostConfigError('configuration_invalid', 'startup');
  return grantFromInput({
    workspaceId: record.workspaceId,
    ownerUserId: record.ownerUserId,
    label: record.label,
    root: record.root,
    access: record.access,
    grantVersion: record.grantVersion as number,
    dynamic: true,
  });
}

function persisted(record: GrantRecord): Omit<GrantRecord, 'dynamic'> {
  return {
    workspaceId: record.workspaceId,
    ownerUserId: record.ownerUserId,
    label: record.label,
    root: record.root,
    access: record.access,
    grantVersion: record.grantVersion,
  };
}

function isOwner(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    value === value.trim() &&
    !/[\u0000\r\n]/.test(value)
  );
}
