/**
 * `session.control.bind` / `rebind` / `unbind`: the daemon owns a TUI's named control
 * socket for as long as that TUI's connection holds the lease
 * (`docs/plans/daemon/spec/transport-unix.md` §5.2).
 *
 * The socket is the same `ControlSocketServer` an in-process TUI opens, in the same
 * `<XDG_RUNTIME_DIR>/term2/control` directory with the same modes; only its owning
 * process changes. EOF releases it without touching the session. `unbind` with
 * `pauseForHandoff` keeps it listening with mutations paused, detached from any
 * connection, until a replacement TUI claims it with `rebind` or the handoff window
 * ends. The standalone control client and the Discord bridge still see only the socket.
 */
import { randomUUID } from 'node:crypto';
import {
  createSessionDiscordSend,
  isControlSocketName,
  startDirectControlSocket,
  type DirectControlSocket,
  type DiscordSend,
} from '../../../clients/control/index.js';
import type { SessionControlBindParams } from '../../../protocol/client-api/client-api-schema-v11.js';
import { DirectProtocolError } from '../../../protocol/errors.js';
import { ClientApiRpcError, type DaemonRpcConnectionContext } from '../../../host/daemon/daemon-rpc.js';
import type { Principal } from '../../../host/in-process-direct-types.js';
import type { DirectApplication } from '../../application.js';
import { LOCAL_PRINCIPAL, requireLocalCaller } from '../../application-workspaces.js';
import type { SessionIndex } from '../../../host/daemon/session-index.js';
import { controlMetadataFor } from '../../launch-control.js';

/**
 * How long a socket paused for a TUI `/restart` waits for the replacement process.
 * The replacement claims it as soon as its terminal is ready, normally within a few
 * seconds. Expiry only closes the socket (never the session), and a late replacement
 * then binds the same name afresh, so a false expiry costs a short gap in control.
 */
const HANDOFF_WINDOW_MS = 30_000;

export type ControlLeaseResult = {
  readonly leaseId: string;
  readonly name: string;
  readonly socketPath: string;
  readonly discordInputEnabled: boolean;
  readonly startup: boolean;
  readonly pid: number;
};

type ControlLease = {
  readonly id: string;
  readonly name: string;
  readonly discordInput: boolean;
  startup: boolean;
  /** The connection holding the lease; undefined while the socket waits for a handoff. */
  connectionId: string | undefined;
  /** Workspace root shown in `status`; follows the bound session. */
  root: string | null;
  /** Set once release begins; a bind still in flight checks it and backs out. */
  closing: boolean;
  /** Releases run one after another; a later one tears down only what was created since. */
  releasing?: Promise<void>;
  socket?: DirectControlSocket;
  unregisterClose?: () => void;
  /** Mutations paused for a handoff; released when a replacement claims the socket. */
  hold?: { readonly drained: Promise<void>; release(): void };
  handoffTimer?: ReturnType<typeof setTimeout>;
  /** `rebind` and `unbind` run one at a time, so a pause can never be lifted by a move already in flight. */
  operations?: Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DaemonControlLeases {
  #app: DirectApplication | undefined;
  #sessions: Pick<SessionIndex, 'get'> | undefined;
  #resolveWorkspaceRoot: ((workspaceId: string) => string) | undefined;
  #isTerminalSession: (sessionId: string) => boolean = () => true;
  readonly #leases = new Map<string, ControlLease>();
  /** Names are reserved before the first await, so two binds cannot race for one name. */
  readonly #names = new Map<string, ControlLease>();
  #closed = false;

  constructor(private readonly options: { readonly handoffWindowMs?: number } = {}) {}

  /**
   * `sessions` and `resolveWorkspaceRoot` are the daemon's session index and local workspace
   * resolver. `isTerminalSession` is false for a session launched headless or for ACP: in
   * process only a terminal ever has a control socket, so those sessions never get one here.
   */
  attach(
    app: DirectApplication,
    sessions: Pick<SessionIndex, 'get'>,
    resolveWorkspaceRoot: (workspaceId: string) => string,
    isTerminalSession: (sessionId: string) => boolean,
  ): void {
    this.#app = app;
    this.#sessions = sessions;
    this.#resolveWorkspaceRoot = resolveWorkspaceRoot;
    this.#isTerminalSession = isTerminalSession;
  }

  #requireTerminalSession(sessionId: string): void {
    if (!this.#isTerminalSession(sessionId)) {
      throw new ClientApiRpcError(
        'forbidden',
        'Control sockets attach only to terminal sessions, not to headless or ACP sessions.',
      );
    }
  }

  #serial<T>(lease: ControlLease, operation: () => Promise<T>): Promise<T> {
    const next = (lease.operations ?? Promise.resolve()).then(operation);
    lease.operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Discord authority for one session's tools, as an in-process TUI gives its own
   * sessions: it holds only while a live, opted-in, unpaused socket is bound to that
   * session, and is resolved at each call, so a rebind or release revokes it.
   */
  outbound(sessionId: string): { readonly discordSend: DiscordSend; isDiscordInputEnabled(): boolean } {
    const server = () => this.#serverFor(sessionId);
    return {
      discordSend: createSessionDiscordSend(server, process.env.XDG_RUNTIME_DIR ?? '', sessionId),
      isDiscordInputEnabled: () => server()?.discordSendEnabled === true,
    };
  }

  #serverFor(sessionId: string): DirectControlSocket['socket'] | null {
    let fallback: DirectControlSocket['socket'] | null = null;
    for (const lease of this.#leases.values()) {
      const socket = lease.socket?.socket;
      if (lease.closing || !socket || socket.binding.sessionId !== sessionId) continue;
      if (socket.discordSendEnabled) return socket;
      fallback ??= socket;
    }
    return fallback;
  }

  async controlBind(
    principal: Principal,
    params: SessionControlBindParams,
    connection: DaemonRpcConnectionContext,
  ): Promise<ControlLeaseResult> {
    requireLocalCaller(principal);
    const app = this.#app;
    if (!app || this.#closed) {
      throw new ClientApiRpcError('unavailable', 'The daemon application is not accepting control sockets.');
    }
    if (!isControlSocketName(params.name)) {
      throw new ClientApiRpcError('invalid_request', 'Invalid control socket name. Use 1–64 letters, digits, _ or -.');
    }
    this.#requireTerminalSession(params.sessionId);
    const holder = this.#names.get(params.name);
    if (holder) {
      throw new ClientApiRpcError(
        'busy',
        holder.connectionId === undefined
          ? `Control socket name ${params.name} is held for a restarting terminal.`
          : `Control socket name ${params.name} is already bound on this daemon.`,
        { retryable: true },
      );
    }
    const lease: ControlLease = {
      id: `lease_${randomUUID().replace(/-/g, '')}`,
      name: params.name,
      discordInput: params.discordInput,
      startup: params.startup === true,
      connectionId: connection.connectionId,
      root: null,
      closing: false,
    };
    this.#names.set(lease.name, lease);
    this.#leases.set(lease.id, lease);
    // Bound to the connection before any await, so EOF mid-bind releases what exists so far.
    lease.unregisterClose = connection.onDisconnect(() => void this.#release(lease));
    try {
      lease.root = await this.#root(params.sessionId);
      this.#backOutIfReleased(lease);
      try {
        lease.socket = await startDirectControlSocket({
          host: app.host,
          principal,
          sessionId: params.sessionId,
          name: lease.name,
          discordInput: lease.discordInput,
          ...(lease.root !== null ? { cwd: lease.root } : {}),
          metadata: controlMetadataFor(app, () => lease.root),
        });
      } catch (error) {
        // An unknown or forbidden session keeps its protocol code; a socket that cannot open is unavailable.
        if (error instanceof DirectProtocolError) throw error;
        throw new ClientApiRpcError('unavailable', messageOf(error));
      }
      this.#backOutIfReleased(lease);
      return this.#result(lease);
    } catch (error) {
      // Re-entrant: tears down whatever was created after an earlier release began.
      await this.#release(lease);
      throw error;
    }
  }

  /**
   * The lease's own connection moves the socket to another session (`/clear`,
   * `/resume`), or a replacement connection claims a socket held for a handoff. A
   * failed move closes the socket, as in-process: it must not keep advertising the
   * session the terminal just left.
   */
  async controlRebind(
    principal: Principal,
    params: { readonly leaseId: string; readonly sessionId: string },
    connection: DaemonRpcConnectionContext,
  ): Promise<ControlLeaseResult> {
    requireLocalCaller(principal);
    const lease = this.#leases.get(params.leaseId);
    if (!lease) throw new ClientApiRpcError('not_found', 'No such control lease for this connection.');
    return this.#serial(lease, () => this.#rebind(lease, params, connection));
  }

  async #rebind(
    lease: ControlLease,
    params: { readonly leaseId: string; readonly sessionId: string },
    connection: DaemonRpcConnectionContext,
  ): Promise<ControlLeaseResult> {
    const socket = lease.socket;
    if (
      !socket ||
      lease.closing ||
      (lease.connectionId !== undefined && lease.connectionId !== connection.connectionId)
    ) {
      throw new ClientApiRpcError('not_found', 'No such control lease for this connection.');
    }
    const moving = socket.socket.binding.sessionId !== params.sessionId;
    // Refused before anything changes, so the socket stays where it is.
    if (moving) this.#requireTerminalSession(params.sessionId);
    if (lease.connectionId === undefined) {
      clearTimeout(lease.handoffTimer);
      lease.handoffTimer = undefined;
      lease.connectionId = connection.connectionId;
      lease.startup = true;
      lease.unregisterClose = connection.onDisconnect(() => void this.#release(lease));
    }
    try {
      const root = moving ? await this.#root(params.sessionId) : lease.root;
      this.#backOutIfReleased(lease);
      const hold = lease.hold;
      lease.hold = undefined;
      // A move pauses again within the same tick, so nothing is admitted to the old session in between.
      hold?.release();
      if (moving) {
        try {
          await socket.rebind(params.sessionId);
        } catch (error) {
          throw new ClientApiRpcError('unavailable', `Control socket closed: ${messageOf(error)}`);
        }
        lease.root = root;
      }
      this.#backOutIfReleased(lease);
      return this.#result(lease);
    } catch (error) {
      await this.#release(lease);
      throw error;
    }
  }

  async controlUnbind(
    principal: Principal,
    params: { readonly leaseId: string; readonly pauseForHandoff?: boolean },
    connection: DaemonRpcConnectionContext,
  ): Promise<void> {
    requireLocalCaller(principal);
    const lease = this.#leases.get(params.leaseId);
    if (!lease) throw new ClientApiRpcError('not_found', 'No such control lease for this connection.');
    await this.#serial(lease, () => this.#unbind(lease, params, connection));
  }

  async #unbind(
    lease: ControlLease,
    params: { readonly leaseId: string; readonly pauseForHandoff?: boolean },
    connection: DaemonRpcConnectionContext,
  ): Promise<void> {
    if (lease.closing || lease.connectionId !== connection.connectionId) {
      throw new ClientApiRpcError('not_found', 'No such control lease for this connection.');
    }
    const socket = lease.socket;
    if (!params.pauseForHandoff || !socket) {
      await this.#release(lease);
      return;
    }
    // Detached before the drain, so this connection's EOF (the exec) cannot release it.
    const hold = socket.socket.pauseMutations();
    lease.unregisterClose?.();
    lease.unregisterClose = undefined;
    lease.connectionId = undefined;
    lease.hold = hold;
    lease.handoffTimer = setTimeout(() => void this.#release(lease), this.options.handoffWindowMs ?? HANDOFF_WINDOW_MS);
    lease.handoffTimer.unref?.();
    await hold.drained;
  }

  /** Daemon shutdown releases every socket before sessions close, and refuses binds still in flight. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#leases.values()].map((lease) => this.#release(lease)));
  }

  /** A socket binds only a session this daemon knows; a vanished root just leaves `workspaceRoot` empty. */
  async #root(sessionId: string): Promise<string | null> {
    const session = await this.#sessions?.get(LOCAL_PRINCIPAL, sessionId);
    if (!session) throw new DirectProtocolError('not_found', 'Unknown local session.');
    try {
      return this.#resolveWorkspaceRoot?.(session.workspaceId) ?? null;
    } catch {
      return null;
    }
  }

  #backOutIfReleased(lease: ControlLease): void {
    if (lease.closing || this.#closed) {
      throw new ClientApiRpcError('closed', 'The control lease was released while starting.', { retryable: true });
    }
  }

  #result(lease: ControlLease): ControlLeaseResult {
    const socket = lease.socket!.socket;
    return {
      leaseId: lease.id,
      name: lease.name,
      socketPath: socket.socketPath,
      discordInputEnabled: socket.discordInputEnabled,
      startup: lease.startup,
      pid: process.pid,
    };
  }

  #release(lease: ControlLease): Promise<void> {
    lease.closing = true;
    const next = (lease.releasing ?? Promise.resolve()).then(() => this.#teardown(lease));
    lease.releasing = next.catch(() => undefined);
    return next;
  }

  async #teardown(lease: ControlLease): Promise<void> {
    lease.unregisterClose?.();
    lease.unregisterClose = undefined;
    clearTimeout(lease.handoffTimer);
    lease.handoffTimer = undefined;
    const socket = lease.socket;
    lease.socket = undefined;
    lease.hold = undefined;
    try {
      // Detaches the control attachment only; the session keeps running.
      await socket?.close();
    } finally {
      if (this.#names.get(lease.name) === lease) this.#names.delete(lease.name);
      this.#leases.delete(lease.id);
    }
  }
}
