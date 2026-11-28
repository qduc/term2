/**
 * Daemon-owned `term2 serve` HTTP/HTTPS/BFF lease manager (`transport-unix.md` §5,
 * Decision D007, Step 14e Part 1).
 *
 * Composes HTTP/SSE listeners directly over the daemon's ONE `DirectApplication`,
 * ONE conversation store, ONE `GlobalMutationCoordinator`, ONE `DirectProductPorts`,
 * and ONE `SessionIndex`, while binding each listener's lifetime to the calling
 * local Unix connection and delivering pairing OTPs only to that connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DirectHostLifecycleEvent, Principal } from '../../../host/in-process-direct-types.js';
import { createDirectServerHost, createServerAuthentication } from '../../../host/server.js';
import { SqliteReplayLedger } from '../../../host/server-auth.js';
import { ClientApiRpcError, type DaemonRpcConnectionContext } from '../../../host/daemon/daemon-rpc.js';
import type { GlobalMutationCoordinator } from '../../../host/daemon/global-mutations.js';
import type { SessionIndex, SessionIndexRecord } from '../../../host/daemon/session-index.js';
import type { DaemonServeStartParams } from '../../../protocol/client-api/client-api-schema.js';
import { DirectProtocolError } from '../../../protocol/errors.js';
import type { DirectLocalStore } from '../../../session/store.js';
import type { DirectApplication } from '../../application.js';
import { createLocalAuthority, requireLocalCaller, type DirectAuthorityFactory } from '../../application-workspaces.js';
import {
  bindDirectSessionAccess,
  type createDirectProductPorts,
  DirectGlobalConfiguration,
  DirectWorkspaceAuthority,
  serverWorkspaceAdministration,
} from '../../host-config.js';
import type { LiveSessionPosture } from '../../host-config-access.js';
import { prepareServeSshSurface } from '../../remote-context.js';
import { createServePresentation } from '../serve-presentation.js';
import {
  acquireServeStateDirLock,
  loadBffPublicKeys,
  messageOf,
  prepareServeStateDir,
  readLockOwnerPid,
  readPrincipalServeLease,
  resolveGrantVisibilityForRecord,
  resolveServeTransport,
  wrapHostWithLease,
  wrapPresentationWithLease,
  wrapSessionIndexWithLease,
  type ActiveServeLease,
  type VisibilityResult,
} from './serve-lease-helpers.js';

const DEFAULT_SERVE_ISSUER = 'chatforge-bff';
const DEFAULT_SERVE_AUDIENCE = 'term2-gateway';
const PAIRING_OTP_TTL_MS = 5 * 60 * 1_000;

export type DaemonServeLeaseDeps = {
  readonly daemonId: string;
  readonly conversationsDir: string;
  readonly product: ReturnType<typeof createDirectProductPorts>;
  readonly capabilities: NonNullable<ConstructorParameters<typeof DirectGlobalConfiguration>[6]>;
  readonly mutations: GlobalMutationCoordinator;
  readonly localWorkspaceIdForRoot: (root: string) => string;
};

export class DaemonServeLeaseManager {
  readonly #leases = new Map<string, ActiveServeLease>();
  readonly #closingLeases = new Set<Promise<void>>();
  readonly #context = new AsyncLocalStorage<ActiveServeLease>();
  readonly #sessionRoots = new Map<string, string>();
  readonly #liveSessionPosture = new Map<string, LiveSessionPosture>();
  #baseStore: DirectLocalStore | null = null;
  #app: DirectApplication | null = null;
  #sessionIndex: SessionIndex | null = null;

  constructor(private readonly deps: DaemonServeLeaseDeps) {}

  bindRuntime(app: DirectApplication, sessionIndex: SessionIndex): void {
    this.#app = app;
    this.#sessionIndex = sessionIndex;
  }

  resolveBinding(sessionId: string): {
    readonly binding?: { readonly client: string; readonly id: string };
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } | null {
    if (!this.#app) return null;
    try {
      const details = this.#app.sessionDetails(sessionId);
      return { binding: details.binding, createdAt: details.createdAt, updatedAt: details.updatedAt };
    } catch {
      return null;
    }
  }

  recordSessionRoot(sessionId: string, root: string): void {
    this.#sessionRoots.set(sessionId, root);
  }

  recordSessionPosture(sessionId: string, posture: LiveSessionPosture): void {
    this.#liveSessionPosture.set(sessionId, posture);
  }

  observeLifecycle(event: DirectHostLifecycleEvent): void {
    if (event.workspace.target === 'local') {
      this.#sessionRoots.set(event.sessionId, event.workspace.root);
    }
    if (event.kind === 'closed') {
      this.#liveSessionPosture.delete(event.sessionId);
      return;
    }
    const existing = this.#liveSessionPosture.get(event.sessionId);
    if (existing) {
      this.#liveSessionPosture.set(event.sessionId, {
        workspaceAccess: event.workspace.access,
        allowUnsandboxed: existing.allowUnsandboxed,
      });
    }
  }

  activeLease(): ActiveServeLease | null {
    const scoped = this.#context.getStore();
    return scoped && !scoped.stopped ? scoped : null;
  }

  createUnifiedAuthority(): DirectAuthorityFactory {
    const local = createLocalAuthority(() => true);
    return (store) => {
      this.#baseStore = store;
      return {
        authorize: async (principal, request) => {
          if (principal.via === 'local') return await local.authorize(principal, request);
          const lease = this.activeLease();
          if (!lease || principal.userId !== lease.ownerUserId) {
            throw new DirectProtocolError('forbidden', 'Only the local owner may use this server.');
          }
          await lease.access.authorize(principal, request);
        },
        resolveGrant: (principal, grant) => {
          if (principal.via === 'local') return local.resolveGrant(principal, grant);
          const lease = this.activeLease();
          if (!lease) {
            throw new DirectProtocolError('forbidden', 'Only the local owner may use this server.');
          }
          return lease.access.resolveWorkspace(principal, grant);
        },
        resolveStored: (root, identity) => {
          const lease = this.activeLease();
          if (lease) return lease.access.resolveStoredRoot(root, identity);
          return local.resolveStored(root, identity);
        },
        canRun: (workspace) => {
          const lease = this.activeLease();
          if (lease) return true;
          return local.canRun(workspace);
        },
        createSession: (workspace, model, binding) => {
          const lease = this.activeLease();
          if (lease) return lease.access.sessions.create(workspace, model, binding);
          return store.create(workspace, model, binding);
        },
      };
    };
  }

  async authorizeModel(
    next: { readonly provider: string; readonly model: string },
    previous: { readonly provider: string; readonly model: string },
  ): Promise<void> {
    const lease = this.activeLease();
    if (!lease) return;
    if (next.provider === previous.provider && next.model === previous.model) return;
    await lease.configuration.assertModel(next.provider, next.model);
  }

  prepareServeSurface(
    ctx: Parameters<typeof prepareServeSshSurface>[1],
  ): ReturnType<typeof prepareServeSshSurface> | undefined {
    const lease = this.activeLease();
    if (!lease) return undefined;
    return prepareServeSshSurface(lease.grants, ctx);
  }

  serveSurfaceOptions(
    sessionId: string,
    ctx?: {
      readonly workspace: { readonly access: 'read' | 'read_write' };
      readonly binding?: { readonly client: string; readonly id: string };
    },
  ) {
    const lease = this.activeLease();
    if (!lease) return null;
    const allowUnsandboxed = ctx?.binding ? lease.grants.kindOf(ctx.binding.id) === 'host' : false;
    if (ctx) this.recordSessionPosture(sessionId, { workspaceAccess: ctx.workspace.access, allowUnsandboxed });
    return {
      autoApprove: false,
      interactive: true,
      sessionBrowser: true,
      allowUnsandboxed,
      shellEscapeApproval: true,
      preserveSandboxedShellApproval: true,
      mcp: undefined,
    };
  }

  resolveVisibility(principal: Principal, record: SessionIndexRecord): VisibilityResult {
    if (principal.via === 'local') {
      return {
        visible: true,
        workspaceId: this.deps.localWorkspaceIdForRoot(record.workspaceRoot),
        workspaceRoot: record.workspaceRoot,
      };
    }
    const lease = readPrincipalServeLease(principal) ?? this.activeLease();
    if (!lease || lease.stopped) return { visible: false };
    return resolveGrantVisibilityForRecord(lease, principal, record);
  }

  async startLease(
    principal: Principal,
    params: DaemonServeStartParams,
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>> {
    requireLocalCaller(principal);
    if (!this.#app || !this.#sessionIndex || !this.#baseStore) {
      throw new ClientApiRpcError('unavailable', 'Daemon application is not ready for serve leases.');
    }
    const stateDir = prepareServeStateDir(params.stateDir);
    for (const existing of this.#leases.values()) {
      if (!existing.stopped && existing.stateDir === stateDir) {
        const holder = readLockOwnerPid(path.join(stateDir, 'serve.lock.pid')) ?? process.pid;
        throw new ClientApiRpcError(
          'busy',
          `state directory ${stateDir} is already in use by another term2 serve process (pid ${holder}); stop it or pass a different --state-dir.`,
        );
      }
    }
    const keys = loadBffPublicKeys(params.bffKeys);
    if (keys.size === 0 && !params.pairing) {
      throw new ClientApiRpcError(
        'invalid_request',
        'provide at least one --bff-key <kid>=<pem path> or enable --pairing',
      );
    }
    const transportOptions = resolveServeTransport(params.transport);
    const releaseLock = acquireServeStateDirLock(stateDir);
    let ledger: SqliteReplayLedger | null = null;
    let transport: ReturnType<typeof createDirectServerHost> | null = null;
    let pendingLease: ActiveServeLease | null = null;
    const leaseId = `srv_${randomUUID().replace(/-/g, '')}`;

    try {
      const hostRoot = realpathSync(homedir());
      const hostWritable =
        params.allowWrite &&
        (() => {
          try {
            accessSync(hostRoot, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })();
      const grants = new DirectWorkspaceAuthority({
        allowWrite: params.allowWrite,
        stateDirectory: stateDir,
        staticGrants: [
          {
            workspaceId: 'host',
            ownerUserId: params.localOwnerUserId,
            label: 'This machine (~)',
            root: hostRoot,
            access: hostWritable ? 'read_write' : 'read',
            kind: 'host',
          },
        ],
      });
      const configuration = new DirectGlobalConfiguration(
        this.deps.product.settings,
        this.deps.product.credentials,
        this.deps.product.providers,
        this.deps.product.oauth,
        this.deps.product.models,
        params.allowWrite,
        this.deps.capabilities,
      );
      const access = bindDirectSessionAccess({
        authority: grants,
        sessions: this.#baseStore,
        directory: this.deps.conversationsDir,
        allowUnboundLocal: true,
        ownerUserId: params.localOwnerUserId,
        allowWrite: params.allowWrite,
        liveSessionPosture: (sessionId) => this.#liveSessionPosture.get(sessionId),
      });
      ledger = new SqliteReplayLedger(path.join(stateDir, 'replay.sqlite'));
      const app = this.#app;
      const sessionIndex = this.#sessionIndex;
      const closeWorkspaceSessions = app.host.closeWorkspaceSessions?.bind(app.host);
      if (!closeWorkspaceSessions) throw new Error('The direct host cannot close workspace sessions.');

      const rawPresentation = createServePresentation({
        app,
        grants,
        configuration,
        allowWrite: params.allowWrite,
        allowUnboundLocal: true,
        ownerUserId: params.localOwnerUserId,
        resolveSessionRoot: (sessionId) => this.#sessionRoots.get(sessionId),
        onSessionCreated: (id) => sessionIndex.refresh(id),
      });
      const auditPath = path.join(stateDir, 'server-audit.jsonl');

      pendingLease = {
        leaseId,
        connectionId: connection.connectionId,
        stateDir,
        ownerUserId: params.localOwnerUserId,
        allowWrite: params.allowWrite,
        grants,
        configuration,
        access,
        ledger,
        transport: null as unknown as ReturnType<typeof createDirectServerHost>,
        releaseLock,
        unregisterDisconnect: () => undefined,
        stopped: false,
      };
      const scopedHost = wrapHostWithLease(app.host, this.#context, pendingLease);
      const scopedIndex = wrapSessionIndexWithLease(sessionIndex, this.#context, pendingLease);
      const scopedPresentation = wrapPresentationWithLease(rawPresentation, this.#context, pendingLease);
      const workspaces = serverWorkspaceAdministration(grants, closeWorkspaceSessions, {
        onRevoked: (root) => scopedIndex.notifyWorkspaceRevoked(root),
        onGranted: (grantPrincipal, root) => scopedIndex.notifyWorkspaceGranted(grantPrincipal, root),
      });

      transport = createDirectServerHost(
        {
          host: scopedHost,
          workspaces,
          sessionIndex: scopedIndex,
          mutations: this.deps.mutations,
          daemonId: this.deps.daemonId,
          models: () => configuration.listModels(),
          skills: (caller, workspaceId) => {
            if (workspaceId && grants.kindOf(workspaceId) === 'ssh') return [];
            const cwd = workspaceId
              ? grants.resolveWorkspace(caller, grants.resolveGrant(caller, workspaceId)).workspace.root
              : homedir();
            return app.skills(cwd).map((skill) => ({
              name: skill.name,
              description: skill.description,
              isProjectLevel: skill.isProjectLevel,
            }));
          },
          configuration,
          presentation: scopedPresentation,
          localOwnerUserId: params.localOwnerUserId,
          audit: (event) => appendFile(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
        },
        {
          transport: transportOptions,
          authentication: createServerAuthentication({
            issuer: DEFAULT_SERVE_ISSUER,
            audience: DEFAULT_SERVE_AUDIENCE,
            publicKeys: keys,
            replayLedger: ledger,
            ...(params.pairing
              ? {
                  pairing: {
                    enabled: true,
                    trustFilePath: path.join(stateDir, 'trusted-clients.json'),
                    printOtp: (code: string) => {
                      connection.emitEvent('serve.pairing_otp', {
                        leaseId,
                        code,
                        expiresAt: new Date(Date.now() + PAIRING_OTP_TTL_MS).toISOString(),
                      });
                    },
                  },
                }
              : {}),
          }),
        },
      );
      pendingLease.transport = transport;
      this.#leases.set(leaseId, pendingLease);
      // Start listener and register disconnect cleanup so EOF mid-start awaits startPromise before stopping.
      pendingLease.startPromise = transport.start();
      pendingLease.unregisterDisconnect = connection.onDisconnect(() => this.#releaseLease(leaseId));
      await pendingLease.startPromise;
      if (pendingLease.stopped) {
        await Promise.allSettled([...this.#closingLeases]);
        throw new ClientApiRpcError('closed', 'Client disconnected while starting serve lease.');
      }
      const endpoint =
        params.transport.kind === 'socket'
          ? `transport=socket path=${params.transport.socketPath}`
          : `transport=tls host=${params.transport.host} port=${params.transport.port}`;
      return { leaseId, stateDir, endpoint };
    } catch (error) {
      if (pendingLease?.stopped) {
        await Promise.allSettled([...this.#closingLeases]);
      } else {
        this.#leases.delete(leaseId);
        pendingLease?.unregisterDisconnect();
        try {
          await transport?.stop();
        } catch {
          // Best-effort cleanup on start failure.
        }
        try {
          ledger?.close();
        } catch {
          // Best-effort cleanup on start failure.
        }
        releaseLock();
      }
      if (error instanceof ClientApiRpcError) throw error;
      throw new ClientApiRpcError('unavailable', messageOf(error));
    }
  }

  async stopLease(
    principal: Principal,
    leaseId: string,
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>> {
    requireLocalCaller(principal);
    const lease = this.#leases.get(leaseId);
    if (!lease) throw new ClientApiRpcError('not_found', `Serve lease "${leaseId}" not found.`);
    if (lease.connectionId !== connection.connectionId) {
      throw new ClientApiRpcError('forbidden', 'Serve lease belongs to another connection.');
    }
    await this.#releaseLease(leaseId);
    return { stopped: true };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#leases.keys()].map((id) => this.#releaseLease(id)));
    await Promise.allSettled([...this.#closingLeases]);
  }

  #releaseLease(leaseId: string): Promise<void> {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.stopped) return Promise.resolve();
    lease.stopped = true;
    this.#leases.delete(leaseId);
    lease.unregisterDisconnect();
    const cleanup = (async () => {
      try {
        await lease.startPromise?.catch(() => undefined);
      } finally {
        try {
          await lease.transport.stop();
        } finally {
          try {
            lease.ledger.close();
          } finally {
            lease.releaseLock();
          }
        }
      }
    })();
    this.#closingLeases.add(cleanup);
    void cleanup.finally(() => {
      this.#closingLeases.delete(cleanup);
    });
    return cleanup;
  }
}
