/**
 * How each daemon session was launched: the approval policy and flags a create or launch hands the
 * session it starts, and what a connection's launch asked for until it attaches (`launch-gate.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DaemonRpcConnectionContext } from '../../../host/daemon/daemon-rpc.js';
import type { SessionApprovalPolicy, SessionLaunchParams } from '../../../protocol/client-api/client-api-schema.js';

/** Launch-only surface flags; the daemon records them for the runtime the launch opens. */
export type DaemonLaunchFlags = Pick<SessionLaunchParams, 'requireSandbox' | 'clientMode'>;

/** What one create or launch hands the session it starts, and that session's id when it opens an existing one. */
export type DaemonLaunchValues = {
  readonly policy?: SessionApprovalPolicy;
  readonly flags?: DaemonLaunchFlags;
  readonly sessionId?: string;
  /** Session-only settings the launch applies once the session is open; unset ones take the saved value. */
  readonly approvalMode?: string;
  readonly sandboxEnabled?: boolean;
};

/** One create's or launch's values while it starts its session (see `DaemonLaunchPolicies.withLaunch`). */
type LaunchFrame = {
  readonly policy: SessionApprovalPolicy | undefined;
  readonly flags: DaemonLaunchFlags | undefined;
  /** The session these values belong to: named by a resume or fork, else the first one built in the frame. */
  sessionId: string | undefined;
  /** False once the create or open has returned. */
  open: boolean;
};

/**
 * How each live session was launched, read by its tool surface and by control-socket admission.
 * A create or launch runs its own session start inside `withLaunch`; the first surface build of
 * that session, inside that call, adopts the launch's values. They live in an async-local frame,
 * not on the daemon, so an attach that opens another session at the same time never sees them.
 */
export class DaemonLaunchPolicies {
  readonly #policies = new Map<string, SessionApprovalPolicy>();
  readonly #flags = new Map<string, DaemonLaunchFlags>();
  readonly #launch = new AsyncLocalStorage<LaunchFrame>();
  /** Per connection: sessions it launched and has not attached yet, with what each launch asked for. */
  readonly #reservations = new Map<string, Map<string, DaemonLaunchValues>>();

  /** `isHeldByAcp`: a session a live ACP client holds reopens only with the ACP surface, whoever reopens it. */
  constructor(private readonly isHeldByAcp: (sessionId: string) => boolean) {}

  /**
   * Runs `start`, the create or open that starts one launch's session, with that launch's values.
   * `sessionId` names the session when the launch opens an existing one; a new session's id is
   * not known until it is built, so the first session built inside `start` takes the values.
   */
  async withLaunch<T>(values: DaemonLaunchValues, start: () => Promise<T>): Promise<T> {
    const frame: LaunchFrame = {
      policy: values.policy,
      flags: values.flags,
      sessionId: values.sessionId,
      open: true,
    };
    try {
      return await this.#launch.run(frame, start);
    } finally {
      // Work `start` left behind (timers, listeners) keeps this async context; it must not adopt later.
      frame.open = false;
    }
  }

  /** The launch frame `sessionId` is being built in, if it is that launch's session. */
  #launchOf(sessionId: string): LaunchFrame | undefined {
    const frame = this.#launch.getStore();
    if (!frame?.open) return undefined;
    frame.sessionId ??= sessionId;
    return frame.sessionId === sessionId ? frame : undefined;
  }

  /** The session's approval policy, adopting its own launch's values on first sight. */
  policyFor(sessionId: string): SessionApprovalPolicy | undefined {
    const held = this.isHeldByAcp(sessionId);
    if (held && !this.#flags.has(sessionId)) this.#flags.set(sessionId, { clientMode: 'acp' });
    const launch = held ? undefined : this.#launchOf(sessionId);
    if (launch?.policy !== undefined && !this.#policies.has(sessionId)) {
      this.#policies.set(sessionId, launch.policy);
    }
    if (launch?.flags !== undefined && !this.#flags.has(sessionId)) {
      this.#flags.set(sessionId, launch.flags);
    }
    return this.#policies.get(sessionId);
  }

  /** Reads the records only, without adopting pending values. */
  modeOf(sessionId: string, policy = this.#policies.get(sessionId)) {
    const flags = this.#flags.get(sessionId);
    const isAcp = flags?.clientMode === 'acp';
    return { flags, isAcp, isHeadless: policy?.mode === 'headless' || flags?.clientMode === 'headless' };
  }

  isAcp(sessionId: string): boolean {
    return this.#flags.get(sessionId)?.clientMode === 'acp';
  }

  forget(sessionId: string): void {
    this.#policies.delete(sessionId);
    this.#flags.delete(sessionId);
  }

  /** The launch values a live session was built with; none means a session no launch started. */
  recordsOf(sessionId: string): { readonly policy?: SessionApprovalPolicy; readonly flags?: DaemonLaunchFlags } {
    return { policy: this.#policies.get(sessionId), flags: this.#flags.get(sessionId) };
  }

  /**
   * Remembers what a connection's launch of `sessionId` asked for, until that connection attaches
   * the session (`release`) or disconnects; a later launch of it by the same connection replaces it.
   */
  reserve(connection: DaemonRpcConnectionContext, sessionId: string, values: DaemonLaunchValues): void {
    let held = this.#reservations.get(connection.connectionId);
    if (!held) {
      const created = new Map<string, DaemonLaunchValues>();
      held = created;
      this.#reservations.set(connection.connectionId, created);
      connection.onDisconnect(() => {
        if (this.#reservations.get(connection.connectionId) === created) {
          this.#reservations.delete(connection.connectionId);
        }
      });
    }
    held.set(sessionId, values);
  }

  reservation(connectionId: string | undefined, sessionId: string): DaemonLaunchValues | undefined {
    return connectionId === undefined ? undefined : this.#reservations.get(connectionId)?.get(sessionId);
  }

  /** Drops `values` once its connection has attached, unless a newer launch replaced it. */
  release(connectionId: string | undefined, sessionId: string, values: DaemonLaunchValues): void {
    const held = connectionId === undefined ? undefined : this.#reservations.get(connectionId);
    if (held?.get(sessionId) === values) held.delete(sessionId);
  }

  /** Whether a connection other than `connectionId` launched `sessionId` and has not attached it yet. */
  awaitedByAnother(sessionId: string, connectionId: string | undefined): boolean {
    for (const [owner, held] of this.#reservations) if (owner !== connectionId && held.has(sessionId)) return true;
    return false;
  }
}
