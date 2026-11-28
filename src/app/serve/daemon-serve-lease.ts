/**
 * `daemon.serve.start` / `daemon.serve.stop`: the daemon hosts `term2 serve`'s HTTP
 * listener over its own application for as long as one local connection holds the
 * lease (`docs/plans/daemon/spec/transport-unix.md` §5.1, decisions.md D011).
 *
 * One application serves two kinds of caller, so this module also owns the routing
 * authority. Local callers keep the local rules. Web callers (assertion or paired
 * device) and web-bound sessions keep `term2 serve`'s workspace-grant rules, read
 * from the lease's state directory. Unbound (local) sessions stay closed to web
 * callers, as in-process serve never held them; the session index still lists them
 * under a covering grant (D007).
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DaemonServeStartParams } from '../../protocol/client-api/client-api-schema-v11.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { DEFAULT_SERVE_AUDIENCE, DEFAULT_SERVE_ISSUER } from '../../host/gateway/serve-args.js';
import { SqliteReplayLedger } from '../../host/server-auth.js';
import type { DirectServerTransport } from '../../host/server-transport.js';
import type { DirectHostLifecycleEvent, Principal } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-errors.js';
import type { DaemonConnection, DaemonLeasePort } from '../../host/daemon/daemon-rpc.js';
import type { GlobalMutationCoordinator } from '../../host/daemon/global-mutations.js';
import type { DirectLocalStore } from '../../session/store.js';
import type { DirectBinding } from '../../session/facade-types.js';
import type { Workspace } from '../../tools/index.js';
import type { DirectApplication } from '../application.js';
import { requireLocalCaller, type DirectAuthority, type DirectAuthorityFactory } from '../application-workspaces.js';
import { bindDirectSessionAccess, DirectGlobalConfiguration, type createDirectProductPorts } from '../host-config.js';
import type { DirectWorkspaceAuthority } from '../host-config.js';
import { prepareServeSshSurface } from '../remote-context.js';
import {
  acquireServeStateDirLock,
  createServeGrants,
  createServeHttpTransport,
  messageOf,
  prepareServeStateDir,
  readServePublicKeys,
  SERVE_CAPABILITIES,
  ServeRefused,
  serveSessionAuthority,
  serveSessionSurface,
  serveTransportOptions,
  type ServeSessionAccess,
} from './serve-composition.js';
import { createServeSessionIndex, type ServeSessionIndexBundle } from './serve-session-index.js';

type ProductPorts = ReturnType<typeof createDirectProductPorts>;

type ServeLease = {
  readonly id: string;
  readonly connectionId: string;
  readonly grants: DirectWorkspaceAuthority;
  readonly access: ServeSessionAccess;
  readonly authority: DirectAuthority;
  bundle?: ServeSessionIndexBundle;
  transport?: DirectServerTransport;
  ledger?: SqliteReplayLedger;
  releaseLock?: () => void;
  unregisterClose?: () => void;
  released?: Promise<void>;
};

export class DaemonServeLeases implements DaemonLeasePort {
  #store: DirectLocalStore | undefined;
  #app: DirectApplication | undefined;
  #lease: ServeLease | undefined;
  #starting = false;

  constructor(
    private readonly deps: {
      readonly conversationsDir: string;
      readonly product: ProductPorts;
      readonly mutations: GlobalMutationCoordinator;
      readonly daemon: { readonly id: string; readonly version: string; readonly startedAt: string };
    },
  ) {}

  /** The application's authority: local rules for local callers, the lease's grants for web ones. */
  authority(local: DirectAuthority): DirectAuthorityFactory {
    return (store) => {
      this.#store = store;
      const web = (): DirectAuthority => {
        const lease = this.#lease;
        if (!lease) throw new DirectProtocolError('forbidden', 'No term2 serve lease is active.');
        return lease.authority;
      };
      return {
        authorize: (principal, access) =>
          principal.via === 'local' ? local.authorize(principal, access) : web().authorize(principal, access),
        resolveGrant: (principal, grant) =>
          principal.via === 'local' ? local.resolveGrant(principal, grant) : web().resolveGrant(principal, grant),
        resolveStored: (root: string, identity?: Workspace, binding?: DirectBinding) =>
          binding !== undefined || identity?.target === 'ssh'
            ? web().resolveStored(root, identity)
            : local.resolveStored(root, identity),
        // Local roots are all admitted (read_write); a narrower result comes only from a web grant
        // or a recorded read identity, and both run read-only, as in serve.
        canRun: () => true,
        createSession: (workspace, model, binding) => {
          const lease = this.#lease;
          return lease?.access.ownsCreation()
            ? lease.authority.createSession!(workspace, model, binding)
            : store.create(workspace, model, binding);
        },
      };
    };
  }

  attach(app: DirectApplication): void {
    this.#app = app;
  }

  /** The surface for a web-bound session; never consults local launch policies. */
  surface(binding: DirectBinding) {
    return serveSessionSurface(this.#lease?.grants, binding.id);
  }

  async prepareSurface(context: { readonly workspace: Workspace; readonly binding?: DirectBinding }) {
    const lease = this.#lease;
    return lease ? await prepareServeSshSurface(lease.grants, context) : {};
  }

  observeLifecycle(event: DirectHostLifecycleEvent): void {
    this.#lease?.bundle?.observeLifecycle(event);
  }

  async serveStart(
    principal: Principal,
    params: DaemonServeStartParams,
    connection: DaemonConnection,
  ): Promise<{ readonly leaseId: string }> {
    requireLocalCaller(principal);
    const app = this.#app;
    const store = this.#store;
    if (!app || !store) throw new ClientApiRpcError('unavailable', 'The daemon application is not ready.');
    // One listener at a time: two grant sets would make web authority ambiguous (worth-revisiting.md).
    if (this.#lease || this.#starting) {
      throw new ClientApiRpcError('busy', 'A term2 serve lease is already active on this daemon.', {
        retryable: true,
      });
    }
    this.#starting = true;
    let lease: ServeLease | undefined;
    try {
      let stateDir: string;
      let keys: Map<string, string>;
      let releaseLock: () => void;
      let transportOptions: ReturnType<typeof serveTransportOptions>;
      try {
        stateDir = prepareServeStateDir(params.stateDir);
        keys = readServePublicKeys(params.bffKeys);
        if (keys.size === 0 && !params.pairing) {
          throw new ServeRefused('provide at least one --bff-key <kid>=<pem path> or enable --pairing');
        }
        transportOptions = serveTransportOptions(params.transport);
        releaseLock = acquireServeStateDirLock(stateDir);
      } catch (error) {
        if (error instanceof ServeRefused) throw new ClientApiRpcError('invalid_request', error.message);
        throw error;
      }
      const leaseId = `lease_${randomUUID().replace(/-/g, '')}`;
      const grants = createServeGrants({
        stateDir,
        allowWrite: params.allowWrite,
        localOwnerUserId: params.localOwnerUserId,
      });
      const access = bindDirectSessionAccess({
        authority: grants,
        sessions: store,
        directory: this.deps.conversationsDir,
      });
      lease = {
        id: leaseId,
        connectionId: connection.id,
        grants,
        access,
        authority: serveSessionAuthority(access, params.localOwnerUserId),
        releaseLock,
      };
      // Installed before seeding: listing web-bound sessions resolves them through this lease.
      this.#lease = lease;
      const { product } = this.deps;
      const configuration = new DirectGlobalConfiguration(
        product.settings,
        product.credentials,
        product.providers,
        product.oauth,
        product.models,
        params.allowWrite,
        SERVE_CAPABILITIES,
      );
      const closeWorkspaceSessions = app.host.closeWorkspaceSessions?.bind(app.host);
      if (!closeWorkspaceSessions) throw new Error('The direct host cannot close workspace sessions.');
      // A grant edit closes the web sessions it governed, never a local client's session in the same root.
      const webBound = (sessionId: string): boolean => {
        try {
          return app.sessionDetails(sessionId).binding !== undefined;
        } catch {
          return true;
        }
      };
      lease.bundle = createServeSessionIndex({
        app,
        grants,
        ownerUserId: params.localOwnerUserId,
        closeWorkspaceSessions: (root) => closeWorkspaceSessions(root, webBound),
      });
      await lease.bundle.index.seed();
      lease.ledger = new SqliteReplayLedger(path.join(stateDir, 'replay.sqlite'));
      lease.transport = createServeHttpTransport({
        app,
        grants,
        configuration,
        sessionIndexBundle: lease.bundle,
        stateDir,
        localOwnerUserId: params.localOwnerUserId,
        allowWrite: params.allowWrite,
        transport: transportOptions,
        issuer: DEFAULT_SERVE_ISSUER,
        audience: DEFAULT_SERVE_AUDIENCE,
        publicKeys: keys,
        replayLedger: lease.ledger,
        pairing: params.pairing,
        // Only the lease holder's connection sees the OTP (transport-unix.md §5.1).
        printOtp: (otp, expiresAt) =>
          connection.emit('serve.pairing_otp', {
            leaseId,
            code: otp,
            expiresAt: new Date(expiresAt).toISOString(),
          }),
        mutations: this.deps.mutations,
        daemon: this.deps.daemon,
      });
      try {
        await lease.transport.start();
      } catch (error) {
        throw new ClientApiRpcError('unavailable', `server failed to start: ${messageOf(error)}`);
      }
      const active = lease;
      active.unregisterClose = connection.onClose(() => void this.#release(active));
      return { leaseId };
    } catch (error) {
      if (lease) await this.#release(lease);
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  async serveStop(principal: Principal, leaseId: string, connection: DaemonConnection): Promise<void> {
    requireLocalCaller(principal);
    const lease = this.#lease;
    if (!lease || lease.id !== leaseId || lease.connectionId !== connection.id) {
      throw new ClientApiRpcError('not_found', 'No such serve lease on this connection.');
    }
    await this.#release(lease);
  }

  /** Daemon shutdown releases every listener before sessions close. */
  async closeAll(): Promise<void> {
    if (this.#lease) await this.#release(this.#lease);
  }

  /**
   * Stops the listener; live web sessions keep running in the daemon, reachable again
   * only through a later lease whose grants still admit them.
   */
  #release(lease: ServeLease): Promise<void> {
    lease.released ??= (async () => {
      lease.unregisterClose?.();
      try {
        await lease.transport?.stop();
      } finally {
        lease.bundle?.index.dispose();
        if (this.#lease === lease) this.#lease = undefined;
        try {
          lease.ledger?.close();
        } finally {
          lease.releaseLock?.();
        }
      }
    })();
    return lease.released;
  }
}
