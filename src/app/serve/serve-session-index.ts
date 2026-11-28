/**
 * App-layer composition helper wiring a host `SessionIndex` and workspace grant notifications
 * for `term2 serve` (and the singleton daemon HTTP binding).
 */
import type { DirectHostLifecycleEvent, Principal } from '../../host/in-process-direct-types.js';
import type { ServerWorkspaces } from '../../host/server-contracts.js';
import { createSessionIndex, type SessionIndex, type SessionIndexRecord } from '../../host/daemon/session-index.js';
import type { DirectApplication } from '../application.js';
import { serverWorkspaceAdministration, type DirectWorkspaceAuthority } from '../host-config-workspace.js';

export type ServeSessionIndexBundle = {
  readonly index: SessionIndex;
  readonly workspaces: Required<ServerWorkspaces>;
  readonly observeLifecycle: (event: DirectHostLifecycleEvent) => void;
};

/**
 * Resolve HTTP/web visibility for a session index record.
 * Never exposes `workspaceRoot` over HTTP (transport-http-sse.md §1).
 * For unbound local sessions (`binding === undefined`), allows the local owner iff an active
 * grant covers `record.workspaceRoot` (Decision D007).
 */
function resolveServeVisibility(
  grants: DirectWorkspaceAuthority,
  ownerUserId: string,
  principal: Principal,
  record: SessionIndexRecord,
) {
  if (principal.userId !== ownerUserId) return { visible: false as const };
  if (record.binding) {
    if (record.binding.client !== principal.userId) return { visible: false as const };
    try {
      const grant = grants.resolveGrant(principal, record.binding.id);
      return { visible: true as const, workspaceId: grant.workspaceId };
    } catch {
      return { visible: false as const };
    }
  }
  for (const alias of grants.list(principal)) {
    try {
      const grant = grants.resolveGrant(principal, alias.workspaceId);
      const { workspace } = grants.resolveWorkspace(principal, grant);
      if (workspace.root === record.workspaceRoot) {
        return { visible: true as const, workspaceId: alias.workspaceId };
      }
    } catch {
      // Skip invalid/inaccessible grants.
    }
  }
  return { visible: false as const };
}

export function createServeSessionIndex(options: {
  readonly app: DirectApplication;
  readonly grants: DirectWorkspaceAuthority;
  readonly ownerUserId: string;
  readonly closeWorkspaceSessions: (root: string) => Promise<number>;
}): ServeSessionIndexBundle {
  const { app, grants, ownerUserId, closeWorkspaceSessions } = options;
  const index = createSessionIndex({
    listStored: () => app.listStoredSessions(),
    resolveBinding(sessionId) {
      try {
        const details = app.sessionDetails(sessionId);
        return { binding: details.binding, createdAt: details.createdAt, updatedAt: details.updatedAt };
      } catch {
        return null;
      }
    },
    resolveVisibility: (principal, record) => resolveServeVisibility(grants, ownerUserId, principal, record),
  });
  const workspaces = serverWorkspaceAdministration(grants, closeWorkspaceSessions, {
    onRevoked: (root) => index.notifyWorkspaceRevoked(root),
    onGranted: (principal, root) => index.notifyWorkspaceGranted(principal, root),
  });
  return {
    index,
    workspaces,
    observeLifecycle: (event) => index.observeLifecycle(event),
  };
}
