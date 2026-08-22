import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GatewayPersistenceError } from './contracts.js';

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;

export function assertOpaqueStorageId(value: string, field = 'id'): void {
  if (!OPAQUE_ID.test(value) || value === '.' || value === '..') {
    throw new GatewayPersistenceError('unsafe_root', `invalid opaque ${field}`);
  }
}

/** Hashes IDs before they become path components; the original ID is never a path. */
export function storageHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export type GatewayStorageLayout = {
  readonly root: string;
  readonly indexPath: string;
  readonly sessionsPath: string;
  sessionPath(ownerUserId: string, workspaceId: string, sessionId: string): string;
  existingSessionPath(ownerUserId: string, workspaceId: string, sessionId: string): string | null;
};

function assertDirectoryNotSymlink(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GatewayPersistenceError('unsafe_root', 'gateway data root must be a real directory');
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(directory);
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    throw new GatewayPersistenceError('unsafe_root', 'gateway data root permissions could not be restricted');
  }
}

export function createGatewayStorageLayout(dataRoot: string): GatewayStorageLayout {
  if (!path.isAbsolute(dataRoot) || dataRoot.includes('\u0000')) {
    throw new GatewayPersistenceError('unsafe_root', 'gateway data root must be an absolute path');
  }
  try {
    ensurePrivateDirectory(dataRoot);
    const root = fs.realpathSync(dataRoot);
    if (root !== dataRoot) throw new Error('root is not canonical');
    const sessionsPath = path.join(root, 'sessions');
    ensurePrivateDirectory(sessionsPath);
    const layout: GatewayStorageLayout = {
      root,
      indexPath: path.join(root, 'index.sqlite'),
      sessionsPath,
      sessionPath(ownerUserId, workspaceId, sessionId) {
        assertOpaqueStorageId(ownerUserId, 'owner');
        assertOpaqueStorageId(workspaceId, 'workspace');
        assertOpaqueStorageId(sessionId, 'session');
        const ownerPath = path.join(sessionsPath, storageHash(ownerUserId));
        const workspacePath = path.join(ownerPath, storageHash(workspaceId));
        const sessionPath = path.join(workspacePath, storageHash(sessionId));
        ensurePrivateDirectory(ownerPath);
        ensurePrivateDirectory(workspacePath);
        ensurePrivateDirectory(sessionPath);
        return sessionPath;
      },
      existingSessionPath(ownerUserId, workspaceId, sessionId) {
        assertOpaqueStorageId(ownerUserId, 'owner');
        assertOpaqueStorageId(workspaceId, 'workspace');
        assertOpaqueStorageId(sessionId, 'session');
        const sessionPath = path.join(
          sessionsPath,
          storageHash(ownerUserId),
          storageHash(workspaceId),
          storageHash(sessionId),
        );
        if (!fs.existsSync(sessionPath)) return null;
        assertDirectoryNotSymlink(sessionPath);
        return sessionPath;
      },
    };
    return Object.freeze(layout);
  } catch (error) {
    if (error instanceof GatewayPersistenceError) throw error;
    throw new GatewayPersistenceError('unsafe_root', 'gateway data root is unreadable or unsafe');
  }
}

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
