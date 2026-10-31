/** Workspace and session authority for the direct host. One instance backs every host and store check. */
import fs from 'node:fs';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import type { DirectAccess, Principal, WorkspaceGrant } from '../host/in-process-direct-types.js';
import type { Workspace } from '../tools/index.js';

export type DirectAuthority = {
  /** May this principal perform this operation at all. */
  authorize(principal: Principal, access: DirectAccess): void | Promise<void>;
  /** A client's grant to the workspace a new session runs in. */
  resolveGrant(principal: Principal, grant: WorkspaceGrant): Workspace | Promise<Workspace>;
  /**
   * The store's re-resolution of a stored path. Session metadata stores a path, not
   * a grant, so a root that is not admitted resolves narrower instead of throwing:
   * throwing here would fail a whole listing because of one other project's session.
   */
  resolveStored(root: string): Workspace | Promise<Workspace>;
  /** May a stored session actually run here, rather than only be listed. */
  canRun(workspace: Workspace): boolean;
};

export const LOCAL_PRINCIPAL: Principal = { userId: 'local', via: 'local' };

/** A local grant names its canonical root directly: there is no remote client to hide it from. */
export function localGrant(root: string): WorkspaceGrant {
  return { workspaceId: root, access: 'read_write' };
}

/** Local modes: the one local user, and only the roots the mode admits are writable. */
export function createLocalAuthority(admits: (root: string) => boolean): DirectAuthority {
  const workspace = (root: string): Workspace => ({
    root,
    target: 'local',
    access: admits(root) ? 'read_write' : 'read',
  });
  const requireLocal = (principal: Principal): void => {
    if (principal.via !== 'local') throw new DirectProtocolError('forbidden', 'This host accepts local callers only.');
  };
  return {
    authorize: requireLocal,
    resolveGrant(principal, grant) {
      requireLocal(principal);
      const root = fs.realpathSync(grant.workspaceId);
      const resolved = workspace(root);
      if (resolved.access !== grant.access) {
        throw new DirectProtocolError('forbidden', 'This workspace is not admitted by this mode.');
      }
      return resolved;
    },
    resolveStored: workspace,
    // Narrowing here only means "not admitted", so a local mode never runs it.
    canRun: ({ access }) => access === 'read_write',
  };
}
