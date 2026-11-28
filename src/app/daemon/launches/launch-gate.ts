/**
 * Holds each launch, and the first attach that follows it on the same connection, to the approval
 * posture that launch asked for (worth-revisiting item 18).
 *
 * In-process, every run builds its session from its own flags. The daemon keeps sessions live
 * between clients, and a live session keeps the surface it was built with and any session-only
 * settings a launch applied. So:
 * - a launch that names a live session running a different posture closes and reopens it with its
 *   own values, when nothing uses it (no connection, no work, no other launch still to attach);
 * - otherwise the launch opens the session as it is, and is refused when that posture is wider
 *   than the one it asked for;
 * - the launch leaves a reservation for its connection; that connection's next attach opens the
 *   session with the launch's values if it was closed meanwhile, and is refused if it now runs
 *   wider. Until it attaches, no other launch reopens the session.
 * ACP sessions are left to `admitLaunch` and the holder rule: their surface is the strictest.
 */
import { ClientApiRpcError, type DaemonRpcConnectionContext } from '../../../host/daemon/daemon-rpc.js';
import type { DirectConnection, DirectReplayConnection, Principal } from '../../../host/in-process-direct-types.js';
import type { DirectApplication } from '../../application.js';
import type { DaemonLaunchPolicies, DaemonLaunchValues } from './launch-policies.js';

const APPROVAL_MODE = 'shell.autoApproveMode';
const SANDBOX = 'sandbox.enabled';
const ESCAPE_REVIEW = 'shell.unattendedEscapeReview';

/** What a session runs with that decides what may run without a person. */
type Posture = {
  readonly headless: boolean;
  readonly autoApprove: boolean;
  readonly requireSandbox: boolean;
  approvalMode: unknown;
  sandbox: unknown;
  readonly escapeReview: unknown;
};

function differs(live: Posture, asked: Posture): boolean {
  return (Object.keys(live) as (keyof Posture)[]).some((key) => live[key] !== asked[key]);
}

/** Wider: something may run without a person that would not under the asked posture. Unequal non-`off` modes count. */
function wider(live: Posture, asked: Posture): boolean {
  return (
    (live.autoApprove && !asked.autoApprove) ||
    (asked.requireSandbox && !live.requireSandbox) ||
    (live.approvalMode !== asked.approvalMode && live.approvalMode !== 'off') ||
    (asked.sandbox === true && live.sandbox !== true) ||
    (live.escapeReview === true && asked.escapeReview !== true)
  );
}

function refusal(): ClientApiRpcError {
  return new ClientApiRpcError(
    'busy',
    'This session is open elsewhere with a wider approval posture than this launch asked for. ' +
      'Close it there, or wait until it is idle, and resume again.',
    { retryable: true },
  );
}

function loosening(): ClientApiRpcError {
  return new ClientApiRpcError(
    'busy',
    'This session is open in another client, and this launch would loosen its approval mode or sandbox there. ' +
      'Resume it without those settings, or close it in the other client first.',
    { retryable: true },
  );
}

export type DaemonLaunchGate = ReturnType<typeof createDaemonLaunchGate>;

export function createDaemonLaunchGate(deps: {
  readonly app: DirectApplication;
  readonly launches: DaemonLaunchPolicies;
  /** The saved settings a freshly opened session reads. */
  readonly saved: { getDynamic(key: string): unknown };
}) {
  const { app, launches, saved } = deps;

  /** The live session's posture; null when it is not live, or is an ACP session. */
  const livePosture = (sessionId: string): Posture | null => {
    const settings = app.liveSettings(sessionId);
    if (!settings || launches.isAcp(sessionId)) return null;
    const { policy, flags } = launches.recordsOf(sessionId);
    return {
      headless: policy?.mode === 'headless' || flags?.clientMode === 'headless',
      autoApprove: policy?.mode === 'headless' && policy.autoApprove,
      requireSandbox: flags?.requireSandbox === true,
      approvalMode: settings.getDynamic(APPROVAL_MODE),
      sandbox: settings.getDynamic(SANDBOX),
      escapeReview: settings.getDynamic(ESCAPE_REVIEW),
    };
  };

  /**
   * The posture a fresh session opened for `values` runs with once the launch has applied its
   * settings. `beforeApply`: the launch has yet to apply them, so the ones it sets are not compared.
   */
  const compare = (sessionId: string, values: DaemonLaunchValues, beforeApply: boolean) => {
    const live = livePosture(sessionId);
    if (!live) return { differs: false, wider: false, loosens: false };
    const requireSandbox = values.flags?.requireSandbox === true;
    const asked: Posture = {
      headless: values.policy?.mode === 'headless' || values.flags?.clientMode === 'headless',
      autoApprove: values.policy?.mode === 'headless' && values.policy.autoApprove,
      requireSandbox,
      approvalMode: values.approvalMode ?? saved.getDynamic(APPROVAL_MODE),
      sandbox: requireSandbox ? true : values.sandboxEnabled ?? saved.getDynamic(SANDBOX),
      escapeReview: saved.getDynamic(ESCAPE_REVIEW),
    };
    // What the launch's own settings make of the live session once applied.
    const applied: Posture = {
      ...live,
      ...(values.approvalMode !== undefined ? { approvalMode: values.approvalMode } : {}),
      ...(requireSandbox
        ? { sandbox: true }
        : values.sandboxEnabled !== undefined
        ? { sandbox: values.sandboxEnabled }
        : {}),
    };
    if (beforeApply && values.approvalMode !== undefined) asked.approvalMode = live.approvalMode;
    if (beforeApply && (requireSandbox || values.sandboxEnabled !== undefined)) asked.sandbox = live.sandbox;
    return { differs: differs(live, asked), wider: wider(live, asked), loosens: wider(applied, live) };
  };

  return {
    /** Starts a new session with a launch's values (`DaemonLaunchPolicies.withLaunch`). */
    withLaunch: <T>(values: DaemonLaunchValues, start: () => Promise<T>) => launches.withLaunch(values, start),

    /** Opens the existing session a resume or fork names, for the launch on `connection`. */
    async openTarget(
      principal: Principal,
      sessionId: string,
      values: DaemonLaunchValues,
      connection: DaemonRpcConnectionContext | undefined,
    ): Promise<DirectConnection> {
      const gated = values.flags?.clientMode !== 'acp';
      const own = connection?.connectionId;
      const unused = () => !launches.awaitedByAnother(sessionId, own);
      if (gated && compare(sessionId, values, true).differs && unused()) {
        await app.host.closeSessionIfUnused?.(principal, sessionId, unused);
      }
      const conn = await launches.withLaunch({ ...values, sessionId }, () => app.host.connect(principal, sessionId));
      const after = gated ? compare(sessionId, values, true) : undefined;
      // Another client has it open (beyond this launch's own connection): its settings are not this launch's to loosen.
      const shared = () =>
        (app.host.connectionCount?.(sessionId) ?? 0) > 1 || launches.awaitedByAnother(sessionId, own);
      if (after?.wider || (after?.loosens && shared())) {
        conn.close();
        throw after.wider ? refusal() : loosening();
      }
      return conn;
    },

    /** Called before the launch on `connection` returns `sessionId`, while it still holds the session open. */
    reserve(connection: DaemonRpcConnectionContext | undefined, sessionId: string, values: DaemonLaunchValues): void {
      if (connection && values.flags?.clientMode !== 'acp') launches.reserve(connection, sessionId, values);
    },

    /**
     * Opens a `session.attach`. The first attach after this connection launched the session opens it
     * with that launch's values and is held to them; any other attach sees the session as it is.
     */
    async attach(
      principal: Principal,
      sessionId: string,
      fromSeq: number | undefined,
      connectionId: string | undefined,
    ): Promise<DirectConnection | DirectReplayConnection> {
      const open = (): Promise<DirectConnection | DirectReplayConnection> =>
        fromSeq === undefined
          ? app.host.connect(principal, sessionId)
          : app.host.connect(principal, sessionId, fromSeq);
      const values = launches.reservation(connectionId, sessionId);
      if (!values) return await open();
      let conn: DirectConnection | DirectReplayConnection;
      try {
        conn = await launches.withLaunch({ ...values, sessionId }, open);
      } finally {
        // Held open by this connection now, or the attach failed (a bad cursor, say): either way the
        // reservation is done, so it no longer keeps other launches from reopening the session.
        launches.release(connectionId, sessionId, values);
      }
      if (compare(sessionId, values, false).wider) {
        conn.close();
        throw refusal();
      }
      return conn;
    },
  };
}
