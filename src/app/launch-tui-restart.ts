/** `/restart`: hand this session to a freshly loaded process, once nothing here can write to it. */
import fs from 'node:fs';
import path from 'node:path';
import { createRestartPlan } from '../shared/utils/process-restart.js';
import { acquireDirectWriterLock } from '../session/writer-lock.js';
import type { WireCommand, WireCommandResult, WireSnapshot } from '../protocol/wire.js';
import type { DirectApplication } from './application.js';
import type { DirectControlBridge, DirectControlHold } from './launch-control.js';

export type DirectRestartPlan = ReturnType<typeof createRestartPlan> & { readonly sessionId: string };

/** Reject unusable entries before releasing the current session; do not pin the legacy build layout. */
function assertSupported(): void {
  if (process.platform === 'win32' || typeof process.execve !== 'function') {
    throw new Error('In-place restart requires POSIX Node with process.execve support.');
  }
  if (process.execArgv.length || process.env.NODE_OPTIONS?.trim()) {
    throw new Error('In-place restart does not support Node flags, loaders or NODE_OPTIONS.');
  }
  const entry = process.argv[1];
  if (!entry || !fs.statSync(entry).isFile()) {
    throw new Error('In-place restart requires the current built CLI entry.');
  }
}

function liveTasks(snapshot: WireSnapshot): WireSnapshot['tasks'] {
  return snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'awaiting_interaction');
}

function assertIdle(snapshot: WireSnapshot, stopTasks: boolean): void {
  if (snapshot.activeTurnId !== null)
    throw new Error('Finish or stop the current foreground operation before restarting.');
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
  const restart = createRestartPlan({
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
  return { ...restart, sessionId: snapshot.sessionId };
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
  const restart = plan(latest(), app, bridge, ssh);
  try {
    assertSupported();
  } catch (error) {
    throw new Error(
      `Restart failed: ${error instanceof Error ? error.message : String(error)}\nManual resume: ${
        restart.manualCommand
      }`,
    );
  }
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
export function performRestart({ args, env, sessionId }: DirectRestartPlan, conversationsDir: string): void {
  // Legacy cli.tsx refuses when the conversation lock outlives shutdown.
  try {
    acquireDirectWriterLock(path.join(conversationsDir, `${sessionId}.jsonl`))();
  } catch (error) {
    throw new Error('Conversation lock remains after shutdown; refusing same-PID restart.', { cause: error });
  }
  process.execve?.(process.execPath, [process.execPath, ...args], env);
}
