/** `/restart`: hand this session to a freshly loaded process, once nothing here can write to it. */
import { createRestartPlan } from '../../../source/utils/process-restart.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectControlBridge, DirectControlHold } from './direct-launch-control.js';

export type DirectRestartPlan = ReturnType<typeof createRestartPlan>;

/** Only runners that re-exec cleanly. The source check also pins `dist/cli.js`, which this entry is not. */
function assertSupported(): void {
  if (process.platform === 'win32' || typeof process.execve !== 'function') {
    throw new Error('In-place restart requires POSIX Node with process.execve support.');
  }
  if (process.execArgv.length || process.env.NODE_OPTIONS?.trim()) {
    throw new Error('In-place restart does not support Node flags, loaders or NODE_OPTIONS.');
  }
}

function assertIdle(snapshot: WireSnapshot): void {
  if (snapshot.activeTurnId !== null) throw new Error('Finish or cancel the running turn before restarting.');
  const live = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'awaiting_interaction');
  if (live.length) {
    const names = live.map((task) => `${task.id} (${task.status})`).join(', ');
    throw new Error(`Live background work: ${names}. Cancel it first; /restart stop needs direct task cancel.`);
  }
}

function plan(snapshot: WireSnapshot, app: DirectApplication, bridge: DirectControlBridge): DirectRestartPlan {
  const { settings, profileId } = app.sessionDetails(snapshot.sessionId);
  if (!settings || !profileId) throw new Error('This session has no live runtime to restart.');
  const server = bridge.server;
  return createRestartPlan({
    entry: process.argv[1] ?? '',
    sessionId: snapshot.sessionId,
    model: snapshot.model,
    reasoning: String(settings.get('agent.reasoningEffort')),
    profile: profileId,
    approval: String(settings.get('shell.autoApproveMode')),
    sandbox: settings.get('sandbox.enabled') === true,
    ...(server ? { control: { name: server.name, discordInput: server.discordInputEnabled } } : {}),
  });
}

/**
 * Pauses control input and checks again after it drains, because something
 * admitted while draining would otherwise be lost to the exec. On success the
 * hold stays: the process is about to be replaced.
 */
export async function prepareRestart(
  latest: () => WireSnapshot,
  app: DirectApplication,
  bridge: DirectControlBridge,
): Promise<DirectRestartPlan> {
  assertSupported();
  assertIdle(latest());
  const hold: DirectControlHold | undefined = bridge.hold();
  try {
    await hold?.drained;
    assertIdle(latest());
    return plan(latest(), app, bridge);
  } catch (error) {
    hold?.release();
    throw error;
  }
}

/** Replaces this process. Runs after the host closed, so the new one is the only writer. */
export function performRestart({ args, env }: DirectRestartPlan): void {
  process.execve?.(process.execPath, [process.execPath, ...args], env);
}
