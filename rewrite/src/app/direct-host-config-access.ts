import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { Principal, WorkspaceGrant } from '../host/index.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import type { Workspace } from '../tools/index.js';
import { DirectHostConfigError } from './direct-host-config-error.js';
import type { DirectWorkspaceAuthority } from './direct-host-config-workspace.js';

const DIRECT_ID = /^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Binding = { readonly client: string; readonly id: string };
type ModelRef = { readonly provider: string; readonly model: string };
/**
 * The direct store's create/open/list/close surface. Result types stay the
 * caller's: `DirectLocalStore.create` returns `Promise<DirectLiveSession>`,
 * not `unknown`. This wrapper does not import the session module.
 */
export type DirectBoundSessionStore<TCreated, TOpened> = {
  create(workspace: Workspace, model: ModelRef, binding?: Binding): Promise<TCreated>;
  open(id: string, binding?: Binding): Promise<TOpened>;
  list(
    cursor?: string,
  ): Promise<{ sessions: readonly { id: string; workspace: Workspace; model: ModelRef }[]; cursor?: string }>;
  close(): Promise<void>;
};
type StartFact = {
  readonly type?: string;
  readonly workspace?: string;
  readonly model?: { readonly provider?: string; readonly model?: string };
  readonly binding?: { readonly client?: string; readonly id?: string };
  readonly reasoning?: string;
  readonly profile?: { readonly id?: string };
};
type FactLine = { readonly v?: number; readonly seq?: number; readonly at?: string; readonly fact?: StartFact };
type Frame = { readonly userId: string; readonly workspaceId: string; readonly workspace: Workspace };
const creation = new AsyncLocalStorage<Frame>();

/**
 * The direct log stores `{ client: ownerUserId, id: workspaceId }` and a path.
 * Host.create does not take a binding, so create() copies it from the authority
 * check on the same call. Open refuses a missing or different owner. A path match
 * alone is not authorization, and access is never widened.
 *
 * Wrap the one store the app host already uses. This does not construct a host
 * or a second store. `resolveWorkspace` stays synchronous and records the owner
 * for `sessions.create` on that call; a create outside that check fails closed.
 * Create and open keep the store's own result types.
 */
export function bindDirectSessionAccess<TCreated, TOpened>(options: {
  readonly authority: DirectWorkspaceAuthority;
  readonly sessions: DirectBoundSessionStore<TCreated, TOpened>;
  readonly directory: string;
}): {
  readonly sessions: DirectBoundSessionStore<TCreated, TOpened>;
  authorize(
    principal: Principal,
    access:
      | { kind: 'list' }
      | { kind: 'create'; grant: WorkspaceGrant }
      | { kind: 'read' | 'write'; sessionId: string },
  ): Promise<void>;
  resolveWorkspace(principal: Principal, grant: WorkspaceGrant): Workspace;
  resolveStoredRoot(root: string): Workspace;
} {
  const directory = path.resolve(options.directory);
  const sessions: DirectBoundSessionStore<TCreated, TOpened> = {
    create(workspace, model, binding) {
      const frame = creation.getStore();
      if (!frame) throw new DirectHostConfigError('workspace_authority_revoked', 'authority');
      if (
        frame.workspace.root !== workspace.root ||
        frame.workspace.access !== workspace.access ||
        frame.workspace.target !== workspace.target
      ) {
        throw new DirectHostConfigError('workspace_grant_mismatch', 'authority');
      }
      const required = { client: frame.userId, id: frame.workspaceId };
      if (binding && (binding.client !== required.client || binding.id !== required.id)) {
        throw new DirectHostConfigError('workspace_owner_mismatch', 'authority');
      }
      return options.sessions.create(frame.workspace, model, required);
    },
    open: (id, binding) => options.sessions.open(id, binding),
    list: (cursor) => options.sessions.list(cursor),
    close: () => options.sessions.close(),
  };
  return {
    sessions,
    async authorize(principal, access) {
      if (!principal?.userId) throw forbidden();
      if (access.kind === 'list') return;
      if (access.kind === 'create') {
        options.authority.resolveWorkspace(principal, access.grant);
        return;
      }
      const started = sessionStart(directory, access.sessionId);
      if (!started.binding || started.binding.client !== principal.userId) throw forbidden();
      const grant = options.authority.resolveGrant(principal, started.binding.id);
      const resolved = options.authority.resolveWorkspace(principal, grant);
      if (path.resolve(resolved.workspace.root) !== path.resolve(started.root)) throw forbidden();
      if (access.kind === 'write' && resolved.workspace.access !== 'read_write') throw forbidden();
    },
    resolveWorkspace(principal, grant) {
      const resolved = options.authority.resolveWorkspace(principal, grant);
      creation.enterWith({
        userId: principal.userId,
        workspaceId: resolved.workspaceId,
        workspace: resolved.workspace,
      });
      return resolved.workspace;
    },
    resolveStoredRoot(root) {
      const frame = creation.getStore();
      if (frame && path.resolve(frame.workspace.root) === path.resolve(root)) return frame.workspace;
      return options.authority.resolveStoredRoot(root);
    },
  };
}

/**
 * The `session_started` fact only: owner binding, root, model, profile and the
 * first accepted timestamp. A snapshot cut is not this helper. Presentation
 * timestamps come from the app's `sessionDetails(sessionId, snapshot.seq)`.
 */
export function sessionStart(
  directory: string,
  sessionId: string,
): {
  binding?: Binding;
  root: string;
  at: string;
  seq: number;
  reasoning?: string;
  profileId?: string;
  provider?: string;
  model?: string;
} {
  if (!DIRECT_ID.test(sessionId)) throw forbidden();
  const line = readFirstFact(path.join(directory, `${sessionId}.jsonl`));
  const fact = line?.fact;
  if (
    !line ||
    fact?.type !== 'session_started' ||
    typeof fact.workspace !== 'string' ||
    typeof line.at !== 'string' ||
    !Number.isSafeInteger(line.seq)
  ) {
    throw forbidden();
  }
  const binding =
    fact.binding?.client && fact.binding.id ? { client: fact.binding.client, id: fact.binding.id } : undefined;
  return {
    ...(binding ? { binding } : {}),
    root: fact.workspace,
    at: line.at,
    seq: line.seq as number,
    ...(typeof fact.reasoning === 'string' ? { reasoning: fact.reasoning } : {}),
    ...(fact.profile?.id ? { profileId: fact.profile.id } : {}),
    ...(typeof fact.model?.provider === 'string' && typeof fact.model.model === 'string'
      ? { provider: fact.model.provider, model: fact.model.model }
      : {}),
  };
}

export const directServeToolPosture = (allowWrite: boolean) => ({
  allowWrite,
  autoApprove: false as const,
  allowUnsandboxed: false as const,
  sshEnabled: false as const,
});

function forbidden(): DirectProtocolError {
  return new DirectProtocolError('forbidden', 'Workspace grant does not authorize this principal.');
}

function readFirstFact(file: string): FactLine | undefined {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return parseLine(buffer.toString('utf8').split('\n')[0] ?? '');
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): FactLine | undefined {
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as FactLine;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** ACP admits only an exact canonical grant root for this principal. Tool approval stays off. */
export function directAcpWorkspaces(options: {
  readonly authority: DirectWorkspaceAuthority;
  readonly principal: Principal;
  readonly directory: string;
}): {
  authorize(cwd: string): Promise<WorkspaceGrant>;
  cwd(sessionId: string): Promise<string>;
  readonly toolPosture: { readonly autoApprove: false; readonly allowUnsandboxed: false };
} {
  return {
    async authorize(cwd) {
      return options.authority.admitRoot(options.principal, cwd);
    },
    async cwd(sessionId) {
      const started = sessionStart(options.directory, sessionId);
      if (!started.binding || started.binding.client !== options.principal.userId) throw forbidden();
      const grant = options.authority.admitRoot(options.principal, started.root);
      if (grant.workspaceId !== started.binding.id) throw forbidden();
      return options.authority.resolveWorkspace(options.principal, grant).workspace.root;
    },
    toolPosture: { autoApprove: false, allowUnsandboxed: false },
  };
}
