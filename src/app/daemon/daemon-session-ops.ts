/**
 * Daemon-owned v1.0 session operations (`client-api.md` §§7–8):
 * - `set_goal` with strict schema validation, host-managed attachment, and `expectedGeneration` CAS.
 * - Server-resolved `skill` injection against the session's workspace.
 * - `quota.get` projection via `subscriptionQuotaView`.
 */
import type { Principal } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError } from '../../host/daemon/daemon-rpc.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import { subscriptionQuotaView } from '../../protocol/state.js';
import { createDurableGoal } from '../../session/goal.js';
import { injectSkillIntoTurn } from '../../shared/types/user-turn.js';
import type { DirectApplication } from '../application.js';
import { requireLocalCaller } from '../application-workspaces.js';

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
