import { isTerminalStatus } from '../../services/background-task-activity.js';

/**
 * How long a settled task still needs a UI clock: the compact panel lingers
 * that long so the outcome can be read, then drops the row.
 *
 * The control port keeps terminal registry rows far longer than this (shells
 * by count, subagents by TTL) so Ctrl+G can still inspect them. That retained
 * history must not keep a 1s React `now` tick after the linger expires —
 * each tick redraws the whole Ink tree.
 */
export const BACKGROUND_TASKS_PANEL_GRACE_MS = 5_000;

type ClockObservation = { kind: string; at: number };

export type BackgroundTaskClockRow = {
  status: string;
  completedAt?: number;
  lastObservation?: ClockObservation;
  activity?: { lastObservation?: ClockObservation };
};

/** Frozen settle time for a terminal row, or undefined when none was recorded. */
export const backgroundTaskSettledAt = (task: BackgroundTaskClockRow): number | undefined => {
  if (!isTerminalStatus(task.status)) return undefined;
  if (typeof task.completedAt === 'number') return task.completedAt;
  const observation = task.activity?.lastObservation ?? task.lastObservation;
  if (observation?.kind === 'settled' && typeof observation.at === 'number') return observation.at;
  return undefined;
};

/**
 * Whether the composer still needs a 1s clock for background-task presentation.
 *
 * Live work, an in-flight turn, and rows still inside the panel linger need
 * `now` to advance. The compact task strip reads foreground candidates live
 * during a turn, before React state has caught up; without a clock those rows
 * freeze at 0s. Retained terminal registry rows after idle do not: they are
 * inspectable history, not a reason to repaint a settled terminal.
 */
export const needsBackgroundTaskClock = ({
  snapshotTasks = [],
  detailsTasks = [],
  foregroundCount = 0,
  turnInFlight = false,
  now,
  graceMs = BACKGROUND_TASKS_PANEL_GRACE_MS,
}: {
  snapshotTasks?: readonly BackgroundTaskClockRow[];
  detailsTasks?: readonly BackgroundTaskClockRow[];
  foregroundCount?: number;
  turnInFlight?: boolean;
  now: number;
  graceMs?: number;
}): boolean => {
  if (turnInFlight) return true;
  if (foregroundCount > 0) return true;

  for (const task of [...snapshotTasks, ...detailsTasks]) {
    if (!isTerminalStatus(task.status)) return true;
    const settledAt = backgroundTaskSettledAt(task);
    if (settledAt !== undefined && now - settledAt < graceMs) return true;
  }

  return false;
};
