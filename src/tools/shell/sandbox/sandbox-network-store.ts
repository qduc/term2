import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxProjectKey, sandboxUserStateRoot } from './sandbox-project.js';

export function resolveProjectNetworkStateDirectory(): string {
  return path.join(sandboxUserStateRoot(), 'sandbox-network-approvals');
}

function projectDirectory(workspaceRoot: string): string {
  return path.join(resolveProjectNetworkStateDirectory(), sandboxProjectKey(workspaceRoot));
}

function entryPath(workspaceRoot: string, host: string, port: number): string {
  const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, '');
  const key = createHash('sha256')
    .update(JSON.stringify([normalizedHost, port]))
    .digest('hex');
  return path.join(projectDirectory(workspaceRoot), key);
}

/** Only term2 records approvals. Checkout files are never consulted. */
export function isHostAllowed(host: string, port: number, workspaceRoot: string): boolean {
  return hasApproval(entryPath(workspaceRoot, host, port));
}

export function setProjectNetworkApproval(workspaceRoot: string, host: string, port: number, allowed: boolean): void {
  setApproval(entryPath(workspaceRoot, host, port), allowed);
}

/** Local listener access is separate from approval of external destinations. */
export function isProjectListenerAllowed(workspaceRoot: string): boolean {
  return hasApproval(path.join(projectDirectory(workspaceRoot), 'local-listener'));
}

export function setProjectListenerApproval(workspaceRoot: string, allowed: boolean): void {
  setApproval(path.join(projectDirectory(workspaceRoot), 'local-listener'), allowed);
}

function hasApproval(entry: string): boolean {
  try {
    return fs.realpathSync(entry) === entry && fs.lstatSync(entry).isFile();
  } catch {
    return false;
  }
}

function setApproval(entry: string, allowed: boolean): void {
  let parent = path.dirname(entry);
  while (!fs.lstatSync(parent, { throwIfNoEntry: false })) parent = path.dirname(parent);
  if (fs.realpathSync(parent) !== parent) throw new Error('Sandbox approval state must use a canonical directory');

  if (!allowed) {
    fs.rmSync(entry, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(entry, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600));
}
