/**
 * Daemon-owned v1.0 session operations (`client-api.md` §§7–8):
 * - `set_goal` with strict schema validation, host-managed attachment, and `expectedGeneration` CAS.
 * - Server-resolved `skill` injection against the session's workspace.
 * - `quota.get` projection via `subscriptionQuotaView`.
 * - `DaemonLaunchPolicies`: how each session was launched (approval policy, client mode, sandbox flag),
 *   scoped to the create or launch that starts it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-rpc.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { subscriptionQuotaView } from '../../protocol/state.js';
import { createDurableGoal } from '../../session/goal.js';
import { injectSkillIntoTurn } from '../../shared/types/user-turn.js';
import type { DirectApplication } from '../application.js';
import { requireLocalCaller } from '../application-workspaces.js';
import type { SessionApprovalPolicy, SessionLaunchParams } from '../../protocol/client-api/client-api-schema.js';

/** Launch-only surface flags; the daemon records them for the runtime the launch opens. */
export type DaemonLaunchFlags = Pick<SessionLaunchParams, 'requireSandbox' | 'clientMode'>;

/** What one create or launch hands the session it starts, and that session's id when it opens an existing one. */
export type DaemonLaunchValues = {
  readonly policy?: SessionApprovalPolicy;
  readonly flags?: DaemonLaunchFlags;
  readonly sessionId?: string;
};

const SET_GOAL_KEYS = new Set(['type', 'action', 'expectedGeneration', 'goal', 'proposalId']);
const GOAL_PAYLOAD_KEYS = new Set(['text', 'successCriteria']);
const SET_GOAL_ACTIONS = new Set(['set', 'clear', 'achieved', 'abandon', 'accept_proposal']);

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientApiRpcError('invalid_request', `Invalid ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ClientApiRpcError('invalid_request', `Unrecognized key "${key}" in ${label}.`);
    }
  }
}

export async function applyDaemonSetGoal(
  app: DirectApplication,
  principal: Principal,
  sessionId: string,
  command: Record<string, unknown>,
): Promise<void> {
  requireLocalCaller(principal);
  assertAllowedKeys(command, SET_GOAL_KEYS, 'set_goal');

  const action = command['action'];
  if (typeof action !== 'string' || !SET_GOAL_ACTIONS.has(action)) {
    throw new ClientApiRpcError('invalid_request', 'Unsupported set_goal action.');
  }

  const expectedGeneration = command['expectedGeneration'];
  if (typeof expectedGeneration !== 'number' || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new ClientApiRpcError('invalid_request', 'set_goal requires non-negative integer expectedGeneration.');
  }

  if (command['proposalId'] !== undefined && (typeof command['proposalId'] !== 'string' || !command['proposalId'])) {
    throw new ClientApiRpcError('invalid_request', 'Invalid proposalId in set_goal.');
  }

  let parsedGoal: { text: string; successCriteria?: string } | undefined;
  if (action === 'set') {
    const goalObj = assertPlainObject(command['goal'], 'set_goal.goal');
    assertAllowedKeys(goalObj, GOAL_PAYLOAD_KEYS, 'set_goal.goal');
    const text = typeof goalObj['text'] === 'string' ? goalObj['text'].trim() : '';
    if (!text) throw new ClientApiRpcError('invalid_request', 'Goal text must be a non-empty string.');
    if (goalObj['successCriteria'] !== undefined && typeof goalObj['successCriteria'] !== 'string') {
      throw new ClientApiRpcError('invalid_request', 'Invalid successCriteria in set_goal.goal.');
    }
    const criteria =
      typeof goalObj['successCriteria'] === 'string' && goalObj['successCriteria'].trim().length > 0
        ? goalObj['successCriteria'].trim()
        : undefined;
    parsedGoal = { text, ...(criteria ? { successCriteria: criteria } : {}) };
  } else if (command['goal'] !== undefined) {
    throw new ClientApiRpcError('invalid_request', `set_goal action "${action}" does not accept a goal payload.`);
  }

  // Open through the host attachment map so dormant sessions stay indexed and closable.
  const conn = await app.host.connect(principal, sessionId);
  try {
    if (conn.snapshot.goalGeneration !== expectedGeneration) {
      throw new ClientApiRpcError('stale_revision', 'The goal changed while updating it.');
    }
    if (action === 'clear') {
      await app.setGoal(sessionId, undefined, 'user', expectedGeneration);
      return;
    }
    if (action === 'set') {
      await app.setGoal(
        sessionId,
        createDurableGoal(parsedGoal!.text, parsedGoal!.successCriteria),
        'user',
        expectedGeneration,
      );
      return;
    }
    if (action === 'accept_proposal') {
      const proposal = conn.snapshot.goalProposal;
      if (!proposal) throw new DirectProtocolError('rejected', 'No proposed goal to accept.');
      await app.setGoal(
        sessionId,
        createDurableGoal(proposal.text, proposal.successCriteria),
        'user',
        expectedGeneration,
      );
      return;
    }
    const current = await app.goal(sessionId);
    if (!current) throw new DirectProtocolError('rejected', 'No durable goal is set.');
    await app.setGoal(
      sessionId,
      { ...current, status: action === 'achieved' ? 'achieved' : 'abandoned' },
      'user',
      expectedGeneration,
    );
  } finally {
    conn.close();
  }
}

export function prepareDaemonSkillText(
  app: DirectApplication,
  workspaceRoot: string,
  skillName: string,
  text: string,
): string | null {
  const skill = app.skills(workspaceRoot).find((candidate) => candidate.name.toLowerCase() === skillName.toLowerCase());
  if (!skill) return null;
  return injectSkillIntoTurn({
    text,
    skill: { name: skill.name, description: skill.description, body: skill.body },
  }).text;
}

export async function readDaemonSessionQuota(
  app: DirectApplication,
  principal: Principal,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  requireLocalCaller(principal);
  if (!sessionId) return { quota: null };
  const conn = await app.host.connect(principal, sessionId);
  try {
    return { quota: subscriptionQuotaView(conn.snapshot) };
  } finally {
    conn.close();
  }
}

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
}
