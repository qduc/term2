/** Workspace and session authority for the direct host. One instance backs every host and store check. */
import fs from 'node:fs';
import { DirectProtocolError } from '../protocol/errors.js';
import type { DirectAccess, Principal, WorkspaceGrant } from '../host/in-process-direct-types.js';
import type { DirectLocalStore } from '../session/store.js';
import type { Workspace } from '../tools/index.js';

export type DirectAuthority = {
  /** May this principal perform this operation at all. */
  authorize(principal: Principal, access: DirectAccess): void | Promise<void>;
  /** A client's grant to the workspace a new session runs in. */
  resolveGrant(principal: Principal, grant: WorkspaceGrant): Workspace | Promise<Workspace>;
  /**
   * The current grant for a stored session. `identity` is what the session recorded:
   * a hint to compare with, never authority. The store refuses any result that
   * differs from it, so a narrower grant here refuses the session.
   */
  resolveStored(root: string, identity?: Workspace): Workspace | Promise<Workspace>;
  /** May a stored session actually run here, rather than only be listed. */
  canRun(workspace: Workspace): boolean;
  /** For an authority that records who owns a session. Replaces the store's own create. */
  createSession?: DirectLocalStore['create'];
};

/** For an authority that needs the store itself, which is built after the runtimes. */
export type DirectAuthorityFactory = (store: DirectLocalStore) => DirectAuthority;

export const LOCAL_PRINCIPAL: Principal = { userId: 'local', via: 'local' };

/** A local grant names its canonical root directly: there is no remote client to hide it from. */
export function localGrant(root: string): WorkspaceGrant {
  return { workspaceId: root, access: 'read_write' };
}

export function requireLocalCaller(principal: Principal): void {
  if (principal.via !== 'local') throw new DirectProtocolError('forbidden', 'This host accepts local callers only.');
}

/** Local modes: the one local user, and only the roots the mode admits are writable. */
export function createLocalAuthority(admits: (root: string) => boolean): DirectAuthority {
  const workspace = (root: string): Workspace => ({
    root,
    target: 'local',
    access: admits(root) ? 'read_write' : 'read',
  });
  return {
    authorize: requireLocalCaller,
    resolveGrant(principal, grant) {
      requireLocalCaller(principal);
      const root = fs.realpathSync(grant.workspaceId);
      const resolved = workspace(root);
      if (resolved.access !== grant.access) {
        throw new DirectProtocolError('forbidden', 'This workspace is not admitted by this mode.');
      }
      return resolved;
    },
    resolveStored(root, identity) {
      if (identity && identity.target !== 'local') {
        throw new DirectProtocolError('forbidden', 'This session belongs to an SSH workspace.');
      }
      return workspace(root);
    },
    // Narrowing here only means "not admitted", so a local mode never runs it.
    canRun: ({ access }) => access === 'read_write',
  };
}
