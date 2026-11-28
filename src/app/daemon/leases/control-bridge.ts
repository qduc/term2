/**
 * The daemon-mode TUI's `DirectControlBridge`: the same `/bridge`, startup-flag,
 * session-change and `/restart` behaviour as `createDirectControlBridge`, but the
 * socket lives in the daemon behind a `session.control.*` lease bound to this TUI's
 * connection (`docs/plans/daemon/spec/transport-unix.md` §5.2). Discord send for the
 * session's tools is wired on the daemon side (`DaemonControlLeases.outbound`).
 */
import type { UnixRpcClient } from '../../../host/daemon/unix-rpc-client.js';
import type { DirectControlBridge, DirectControlHold } from '../../launch-control.js';
import type { DirectControlSocketRequest } from '../../launch-types.js';

/** Carries a lease held for `/restart` into the replacement process. Read once, then removed. */
const CONTROL_HANDOFF_ENV = 'TERM2_CONTROL_HANDOFF_LEASE';

const UNBIND_TIMEOUT_MS = 10_000;
/** A release on a dropped connection lands just after the drop; a re-bind waits that long, no more. */
const REBIND_BUSY_RETRIES_MS = [100, 250, 500] as const;

type Lease = {
  readonly leaseId: string;
  readonly name: string;
  readonly socketPath: string;
  readonly discordInputEnabled: boolean;
  readonly rpc: UnixRpcClient;
};

type LeaseResult = {
  readonly leaseId: string;
  readonly name: string;
  readonly socketPath: string;
  readonly discordInputEnabled: boolean;
  readonly pid?: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export type DaemonControlBridge = DirectControlBridge & {
  /** After the TUI reconnected on a new daemon connection: bind the socket again if one was lost with the old one. */
  reattach(sessionId: string): Promise<void>;
};

export function createDaemonControlBridge(rpc: () => UnixRpcClient): DaemonControlBridge {
  let lease: Lease | undefined;
  let boundSession: string | undefined;
  let startup = false;
  let connecting = false;
  /** Set while a `/restart` holds the socket: closing this process must not release it. */
  let handingOff = false;
  /** A socket released by the daemon because our connection dropped; re-bound on reconnect. */
  let lost: { readonly name: string; readonly discordInput: boolean } | undefined;
  /** Only the current lease's connection is watched, so `/bridge connect` cycles add no listeners. */
  let stopWatching: (() => void) | undefined;

  const adopt = (result: LeaseResult, client: UnixRpcClient, sessionId: string): Lease => {
    const next: Lease = { ...result, rpc: client };
    lease = next;
    boundSession = sessionId;
    lost = undefined;
    // The daemon releases a lease on EOF; reflect that instead of advertising a dead socket.
    stopWatching?.();
    stopWatching = client.onClose(() => {
      if (lease !== next || handingOff) return;
      lease = undefined;
      lost = { name: next.name, discordInput: next.discordInputEnabled };
    });
    return next;
  };

  const bind = async (sessionId: string, name: string, discordInput: boolean, isStartup: boolean) => {
    const client = rpc();
    const result = await client.request<LeaseResult>('session.control.bind', {
      sessionId,
      name,
      discordInput,
      ...(isStartup ? { startup: true } : {}),
    });
    return adopt(result, client, sessionId);
  };

  const claimHandoff = async (sessionId: string): Promise<Lease | undefined> => {
    const leaseId = process.env[CONTROL_HANDOFF_ENV];
    delete process.env[CONTROL_HANDOFF_ENV];
    if (!leaseId) return undefined;
    const client = rpc();
    try {
      const result = await client.request<LeaseResult>('session.control.rebind', { leaseId, sessionId });
      return adopt(result, client, sessionId);
    } catch {
      // Expired or already released: bind the name afresh.
      return undefined;
    }
  };

  const release = async (current: Lease | undefined) => {
    if (!current || current.rpc.closed) return;
    // Closing the connection releases it too; an explicit unbind just does it sooner.
    await current.rpc
      .request('session.control.unbind', { leaseId: current.leaseId }, UNBIND_TIMEOUT_MS)
      .catch(() => undefined);
  };

  return {
    // The daemon gives the session's tools their Discord authority; nothing is lent from here.
    outbound: () => ({
      discordSend: async (input) => ({ requestId: input.requestId, delivery: 'unavailable' }),
      isDiscordInputEnabled: () => false,
    }),
    get server() {
      return lease
        ? { name: lease.name, socketPath: lease.socketPath, discordInputEnabled: lease.discordInputEnabled }
        : undefined;
    },
    get isStartup() {
      return startup;
    },
    async attachAtStartup(sessionId, { name, discordInput }: DirectControlSocketRequest) {
      try {
        const claimed = (await claimHandoff(sessionId)) ?? (await bind(sessionId, name, discordInput, true));
        startup = true;
        return `Control socket on: ${claimed.name} (daemon)`;
      } catch (error) {
        return `Control socket off: ${messageOf(error)}`;
      }
    },
    async connect(sessionId, name) {
      if (lease || connecting) throw new Error('A control socket is already connected or connecting.');
      connecting = true;
      try {
        // Asking for the bridge by name is the opt-in to Discord input, as in-process.
        const bound = await bind(sessionId, name, true, false);
        return { name: bound.name, socketPath: bound.socketPath, discordInputEnabled: bound.discordInputEnabled };
      } finally {
        connecting = false;
      }
    },
    async disconnect() {
      const closing = lease;
      lease = undefined;
      boundSession = undefined;
      lost = undefined;
      await release(closing);
    },
    async rebind(sessionId) {
      const current = lease;
      if (!current) return;
      try {
        await current.rpc.request<LeaseResult>('session.control.rebind', { leaseId: current.leaseId, sessionId });
        boundSession = sessionId;
      } catch (error) {
        // The daemon closed the socket on a failed move; make sure nothing keeps it.
        lease = undefined;
        boundSession = undefined;
        startup = false;
        await release(current);
        throw new Error(`Control socket closed: ${messageOf(error)}`);
      }
    },
    hold(): DirectControlHold | undefined {
      const current = lease;
      if (!current) return undefined;
      handingOff = true;
      let released = false;
      const drained = current.rpc
        .request('session.control.unbind', { leaseId: current.leaseId, pauseForHandoff: true })
        .then(() => undefined);
      return {
        drained,
        release() {
          if (released) return;
          released = true;
          handingOff = false;
          const sessionId = boundSession;
          if (lease !== current || sessionId === undefined) return;
          // The restart did not happen: take the socket back on this connection.
          void current.rpc.request('session.control.rebind', { leaseId: current.leaseId, sessionId }).catch(() => {
            if (lease === current) lease = undefined;
          });
        },
      };
    },
    restartEnv: (): Record<string, string> => (lease ? { [CONTROL_HANDOFF_ENV]: lease.leaseId } : {}),
    async reattach(sessionId) {
      const previous = lost;
      if (!previous || lease) return;
      for (const delayMs of [0, ...REBIND_BUSY_RETRIES_MS]) {
        if (delayMs) await wait(delayMs);
        try {
          await bind(sessionId, previous.name, previous.discordInput, startup);
          return;
        } catch (error) {
          if (codeOf(error) !== 'busy') break;
        }
      }
      lost = undefined;
      startup = false;
    },
    async close() {
      const closing = lease;
      lease = undefined;
      boundSession = undefined;
      // A `/restart` hands the socket to the replacement process; the daemon keeps it paused for it.
      if (!handingOff) await release(closing);
    },
  };
}
