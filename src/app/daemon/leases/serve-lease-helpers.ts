/**
 * Pure filesystem/lock/context-wrapping helpers for `DaemonServeLeaseManager`.
 */
import type { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { defaultServeStateDir } from '../../../host/gateway/serve-args.js';
import type { DirectHost, Principal } from '../../../host/in-process-direct-types.js';
import type { createDirectServerHost } from '../../../host/server.js';
import type { SqliteReplayLedger } from '../../../host/server-auth.js';
import type { ServerTransportOptions } from '../../../host/server-contracts.js';
import { ClientApiRpcError } from '../../../host/daemon/daemon-rpc.js';
import type { SessionIndex, SessionIndexRecord } from '../../../host/daemon/session-index.js';
import type { DaemonServeStartParams } from '../../../protocol/client-api/client-api-schema.js';
import type { DirectLocalStore } from '../../../session/store.js';
import type {
  bindDirectSessionAccess,
  DirectGlobalConfiguration,
  DirectWorkspaceAuthority,
} from '../../host-config.js';
import type { DirectServeSessionPresentation } from '../serve-presentation.js';

export type BoundLocalSessionAccess = ReturnType<
  typeof bindDirectSessionAccess<
    Awaited<ReturnType<DirectLocalStore['create']>>,
    Awaited<ReturnType<DirectLocalStore['open']>>
  >
>;

export type ActiveServeLease = {
  readonly leaseId: string;
  readonly connectionId: string;
  readonly stateDir: string;
  readonly ownerUserId: string;
  readonly allowWrite: boolean;
  readonly grants: DirectWorkspaceAuthority;
  readonly configuration: DirectGlobalConfiguration;
  readonly access: BoundLocalSessionAccess;
  readonly ledger: SqliteReplayLedger;
  transport: ReturnType<typeof createDirectServerHost>;
  readonly releaseLock: () => void;
  unregisterDisconnect: () => void;
  stopped: boolean;
};

export type VisibilityResult =
  | { readonly visible: false }
  | { readonly visible: true; readonly workspaceId: string; readonly workspaceRoot?: string };

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareServeStateDir(requested: string): string {
  const directory =
    requested === defaultServeStateDir() ? path.join(path.dirname(requested), 'gateway-next') : requested;
  if (existsSync(path.join(directory, 'gateway-data'))) {
    throw new ClientApiRpcError('invalid_request', `${directory} holds old gateway data; choose a new --state-dir.`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

export function readLockOwnerPid(pidPath: string): number | undefined {
  let pid: number;
  try {
    const text = readFileSync(pidPath, 'utf8').trim();
    if (!/^\d+$/.test(text)) return undefined;
    pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  } catch {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM' ? pid : undefined;
  }
}

export function acquireServeStateDirLock(stateDir: string): () => void {
  const lockPath = path.join(stateDir, 'serve.lock.sqlite');
  const pidPath = path.join(stateDir, 'serve.lock.pid');
  let database: Database.Database | undefined;
  try {
    database = new Database(lockPath, { timeout: 0 });
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      const holder = readLockOwnerPid(pidPath);
      const detail = holder !== undefined ? ` (pid ${holder})` : '';
      throw new ClientApiRpcError(
        'busy',
        `state directory ${stateDir} is already in use by another term2 serve process${detail}; stop it or pass a different --state-dir.`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
  } catch {
    // Diagnostic metadata only; the SQLite lock is the authority.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(pidPath);
    } catch {
      // Best-effort cleanup before releasing the SQLite lock.
    }
    database!.close();
  };
}

export function loadBffPublicKeys(
  bffKeys: readonly { readonly kid: string; readonly pemPath: string }[],
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const { kid, pemPath } of bffKeys) {
    try {
      keys.set(kid, readFileSync(pemPath, 'utf8'));
    } catch (error) {
      throw new ClientApiRpcError(
        'invalid_request',
        `cannot read BFF public key "${kid}" at ${pemPath}: ${messageOf(error)}`,
      );
    }
  }
  return keys;
}

export function resolveServeTransport(transport: DaemonServeStartParams['transport']): ServerTransportOptions {
  if (transport.kind === 'socket') return { socketPath: transport.socketPath };
  for (const [label, file] of [
    ['tls-cert', transport.certPath],
    ['tls-key', transport.keyPath],
  ] as const) {
    try {
      readFileSync(file);
    } catch (error) {
      throw new ClientApiRpcError('invalid_request', `cannot read --${label} at ${file}: ${messageOf(error)}`);
    }
  }
  return {
    host: transport.host,
    port: transport.port,
    tls: { certPath: transport.certPath, keyPath: transport.keyPath, requireClientCert: false },
  };
}

export function wrapHostWithLease(
  host: DirectHost,
  storage: AsyncLocalStorage<ActiveServeLease>,
  lease: ActiveServeLease,
): DirectHost {
  const run = <T>(fn: () => T): T => storage.run(lease, fn);
  const wrapConnection = <T extends { send: (command: never) => Promise<unknown> }>(conn: T): T =>
    new Proxy(conn, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (command: never) => run(() => target.send(command));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return {
    listSessions: (principal, cursor) => run(() => host.listSessions(principal, cursor)),
    createSession: (principal, grant) => run(() => host.createSession(principal, grant)),
    connect: (async (principal: Principal, sessionId: string, fromSeq?: number) =>
      wrapConnection(
        (await run(() =>
          fromSeq === undefined ? host.connect(principal, sessionId) : host.connect(principal, sessionId, fromSeq),
        )) as unknown as { send: (command: never) => Promise<unknown> },
      )) as unknown as DirectHost['connect'],
    ...(host.sendCommand
      ? { sendCommand: (principal, sessionId, command) => run(() => host.sendCommand!(principal, sessionId, command)) }
      : {}),
    ...(host.closeSession
      ? { closeSession: (principal, sessionId) => run(() => host.closeSession!(principal, sessionId)) }
      : {}),
    ...(host.closeWorkspaceSessions
      ? { closeWorkspaceSessions: (root) => run(() => host.closeWorkspaceSessions!(root)) }
      : {}),
    dispose: () => Promise.resolve(),
  };
}

export function wrapSessionIndexWithLease(
  index: SessionIndex,
  storage: AsyncLocalStorage<ActiveServeLease>,
  lease: ActiveServeLease,
): SessionIndex {
  const run = <T>(fn: () => T): T => storage.run(lease, fn);
  return {
    seed: () => index.seed(),
    observeLifecycle: (event) => index.observeLifecycle(event),
    notifyWorkspaceRevoked: (root) => index.notifyWorkspaceRevoked(root),
    notifyWorkspaceGranted: (principal, root) => run(() => index.notifyWorkspaceGranted(principal, root)),
    refresh: (sessionId) => index.refresh(sessionId),
    list: (principal, options) => run(() => index.list(principal, options)),
    get: (principal, sessionId) => run(() => index.get(principal, sessionId)),
    subscribe: (principal, options, listener) => run(() => index.subscribe(principal, options, listener)),
    counts: () => index.counts(),
    dispose: () => undefined,
  };
}

export function wrapPresentationWithLease(
  presentation: DirectServeSessionPresentation,
  storage: AsyncLocalStorage<ActiveServeLease>,
  lease: ActiveServeLease,
): DirectServeSessionPresentation {
  const run = <T>(fn: () => T): T => storage.run(lease, fn);
  return {
    metadata: (principal, snapshot) => run(() => presentation.metadata(principal, snapshot)),
    configuration: (principal, snapshot) => run(() => presentation.configuration!(principal, snapshot)),
    listFiles: (principal, snapshot) => run(() => presentation.listFiles!(principal, snapshot)),
    prepareSkillText: (principal, snapshot, skillName, text) =>
      run(() => presentation.prepareSkillText!(principal, snapshot, skillName, text)),
    withApprovalMode: (principal, snapshot, approvalMode, operation) =>
      run(() => presentation.withApprovalMode!(principal, snapshot, approvalMode, operation)),
    prepareConfiguration: (principal, snapshot, body) =>
      run(() => presentation.prepareConfiguration(principal, snapshot, body)),
    setGoal: (principal, snapshot, action) => run(() => presentation.setGoal!(principal, snapshot, action)),
    handoff: (principal, snapshot, input) => run(() => presentation.handoff!(principal, snapshot, input)),
  };
}

export function resolveGrantVisibilityForRecord(
  lease: ActiveServeLease,
  principal: Principal,
  record: SessionIndexRecord,
): VisibilityResult {
  if (principal.userId !== lease.ownerUserId) return { visible: false };
  if (record.binding) {
    if (record.binding.client !== principal.userId) return { visible: false };
    try {
      const grant = lease.grants.resolveGrant(principal, record.binding.id);
      return { visible: true, workspaceId: grant.workspaceId };
    } catch {
      return { visible: false };
    }
  }
  const canonicalRecord = path.resolve(record.workspaceRoot);
  const aliases = lease.grants.list(principal);
  // Prefer explicit directory grants over the static `host` grant when both share a root.
  const ordered = [...aliases].sort((a, b) => (a.kind === 'host' ? 1 : 0) - (b.kind === 'host' ? 1 : 0));
  for (const alias of ordered) {
    try {
      const grant = lease.grants.resolveGrant(principal, alias.workspaceId);
      const { workspace } = lease.grants.resolveWorkspace(principal, grant);
      if (workspace.target === 'local' && path.resolve(workspace.root) === canonicalRecord) {
        return { visible: true, workspaceId: alias.workspaceId };
      }
    } catch {
      // Skip invalid or inaccessible grants.
    }
  }
  return { visible: false };
}
