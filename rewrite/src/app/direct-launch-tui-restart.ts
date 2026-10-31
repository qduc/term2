/** `/restart`: hand this session to a freshly loaded process, once nothing here can write to it. */
import { createRestartPlan } from '../../../source/utils/process-restart.js';
import type { WireCommand, WireCommandResult, WireSnapshot } from '../protocol/direct-wire.js';
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

function liveTasks(snapshot: WireSnapshot): WireSnapshot['tasks'] {
  return snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'awaiting_interaction');
}

function assertIdle(snapshot: WireSnapshot, stopTasks: boolean): void {
  if (snapshot.activeTurnId !== null) throw new Error('Finish or cancel the running turn before restarting.');
  const live = liveTasks(snapshot);
  if (live.length && !stopTasks) {
    const names = live.map((task) => `${task.id} (${task.status})`).join(', ');
    throw new Error(`Live background work: ${names}. Cancel it first, or use /restart stop to consent to stopping it.`);
  }
}

/** `/restart stop`. Closing the host waits for these tasks, so this only has to ask. */
async function stopLiveTasks(
  snapshot: WireSnapshot,
  send: (command: WireCommand) => Promise<WireCommandResult>,
): Promise<void> {
  for (const task of liveTasks(snapshot)) {
    const result = await send({ type: 'task_control', taskId: task.id, action: 'cancel' });
    if (!result.ok) throw new Error(`Could not stop task ${task.id}: ${result.message}`);
  }
}

type RestartTarget = Parameters<typeof createRestartPlan>[0]['ssh'];

function plan(
  snapshot: WireSnapshot,
  app: DirectApplication,
  bridge: DirectControlBridge,
  ssh: RestartTarget,
): DirectRestartPlan {
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
    ...(ssh ? { ssh } : {}),
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
  ssh: RestartTarget,
  stopTasks?: (command: WireCommand) => Promise<WireCommandResult>,
): Promise<DirectRestartPlan> {
  assertSupported();
  assertIdle(latest(), stopTasks !== undefined);
  const hold: DirectControlHold | undefined = bridge.hold();
  try {
    await hold?.drained;
    assertIdle(latest(), stopTasks !== undefined);
    if (stopTasks) await stopLiveTasks(latest(), stopTasks);
    return plan(latest(), app, bridge, ssh);
  } catch (error) {
    hold?.release();
    throw error;
  }
}

/** Replaces this process. Runs after the host closed, so the new one is the only writer. */
export function performRestart({ args, env }: DirectRestartPlan): void {
  process.execve?.(process.execPath, [process.execPath, ...args], env);
}
