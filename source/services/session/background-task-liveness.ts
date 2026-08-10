/**
 * Shared vocabulary for background-task presentation. Executors own the raw
 * timestamps; the session control port uses this policy to turn them into one
 * UI-safe activity state.
 */
export type BackgroundTaskActivityState = 'active' | 'waiting' | 'quiet' | 'cancelling' | 'settled';
export type BackgroundTaskWaitReason = 'provider' | 'approval' | 'answer';

export type BackgroundTaskActivity = {
  state: BackgroundTaskActivityState;
  lastActivityAt: number;
  reason?: BackgroundTaskWaitReason;
};

export const BACKGROUND_SUBAGENT_QUIET_AFTER_MS = 30_000;
export const BACKGROUND_SHELL_QUIET_AFTER_MS = 10_000;

export function normalizeBackgroundTaskActivity({
  status,
  activityState = 'active',
  waitingReason,
  lastActivityAt,
  now,
  quietAfterMs,
}: {
  status: string;
  activityState?: 'active' | 'waiting' | 'cancelling';
  waitingReason?: BackgroundTaskWaitReason;
  lastActivityAt: number;
  now: number;
  quietAfterMs: number;
}): BackgroundTaskActivity {
  if (isTerminalStatus(status)) return { state: 'settled', lastActivityAt };
  if (status === 'cancelling' || activityState === 'cancelling') {
    return { state: 'cancelling', lastActivityAt };
  }
  if (activityState === 'waiting') {
    return {
      state: 'waiting',
      lastActivityAt,
      ...(waitingReason === undefined ? {} : { reason: waitingReason }),
    };
  }
  if (now - lastActivityAt >= quietAfterMs) return { state: 'quiet', lastActivityAt };
  return { state: 'active', lastActivityAt };
}

export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}
