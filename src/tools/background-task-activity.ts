/** Facts observed locally while background work is alive. Presentation owns wording. */
export type BackgroundTaskObservation =
  | { kind: 'request_dispatched'; at: number }
  | { kind: 'response_started'; at: number }
  | { kind: 'text_received'; at: number }
  | { kind: 'tool_input_received'; at: number; toolName: string; argumentCharCount: number }
  | { kind: 'tool_started'; at: number; toolName: string }
  | { kind: 'tool_completed'; at: number; toolName?: string }
  | { kind: 'retrying'; at: number; attempt: number; maxRetries: number }
  | { kind: 'approval_requested'; at: number }
  | { kind: 'question_asked'; at: number }
  | { kind: 'shell_started'; at: number }
  | { kind: 'shell_output_received'; at: number }
  | { kind: 'stop_requested'; at: number }
  | { kind: 'settled'; at: number };

export type BackgroundTaskLiveness = {
  state: 'recent' | 'quiet';
  lastObservedAt: number;
  ageMs: number;
};

export type BackgroundTaskPhase = 'active' | 'waiting' | 'cancelling' | 'settled';
/** @deprecated Use BackgroundTaskPhase. */
export type BackgroundTaskActivityState = BackgroundTaskPhase;
export type BackgroundTaskWaitReason = 'provider' | 'approval' | 'answer';

export type BackgroundTaskActivity = {
  phase: BackgroundTaskPhase;
  reason?: BackgroundTaskWaitReason;
  lastObservation: BackgroundTaskObservation;
  liveness: BackgroundTaskLiveness;
};

export const BACKGROUND_SUBAGENT_QUIET_AFTER_MS = 30_000;
export const BACKGROUND_SHELL_QUIET_AFTER_MS = 10_000;
export const BACKGROUND_TASK_TOOL_LABEL_LIMIT = 80;

/** Bounds provider-derived labels before they enter retained presentation state. */
export const sanitizeBackgroundTaskToolLabel = (value: string): string => {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > BACKGROUND_TASK_TOOL_LABEL_LIMIT
    ? `${normalized.slice(0, BACKGROUND_TASK_TOOL_LABEL_LIMIT - 1)}…`
    : normalized;
};

export const assessBackgroundTaskLiveness = ({
  lastObservedAt,
  now,
  quietAfterMs,
}: {
  lastObservedAt: number;
  now: number;
  quietAfterMs: number;
}): BackgroundTaskLiveness => {
  const ageMs = Math.max(0, now - lastObservedAt);
  return { state: ageMs >= quietAfterMs ? 'quiet' : 'recent', lastObservedAt, ageMs };
};

/** Compact, bounded wording shared by model-facing background work surfaces. */
export const formatBackgroundTaskLiveness = (activity: BackgroundTaskActivity): string => {
  const phase = activity.phase === 'waiting' && activity.reason ? `waiting (${activity.reason})` : activity.phase;
  return `${phase}, ${activity.liveness.state}; last observed ${formatObservationAge(activity.liveness.ageMs)} ago`;
};

const formatObservationAge = (ageMs: number): string => {
  const totalSeconds = Math.floor(Math.max(0, ageMs) / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

export const isTerminalStatus = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled';

export const normalizeBackgroundTaskActivity = ({
  status,
  activityState = 'active',
  waitingReason,
  lastObservation,
  lastActivityAt,
  now,
  quietAfterMs,
}: {
  status: string;
  activityState?: Exclude<BackgroundTaskPhase, 'settled'>;
  waitingReason?: BackgroundTaskWaitReason;
  lastObservation?: BackgroundTaskObservation;
  /** Compatibility input while registry callers migrate to observations. */
  lastActivityAt?: number;
  now: number;
  quietAfterMs: number;
}): BackgroundTaskActivity => {
  const at = lastObservation?.at ?? lastActivityAt ?? now;
  const observation = lastObservation ?? { kind: isTerminalStatus(status) ? 'settled' : 'request_dispatched', at };
  const phase: BackgroundTaskPhase = isTerminalStatus(status)
    ? 'settled'
    : status === 'cancelling' || activityState === 'cancelling'
    ? 'cancelling'
    : activityState;
  return {
    phase,
    ...(phase === 'waiting' && waitingReason !== undefined ? { reason: waitingReason } : {}),
    lastObservation: observation,
    liveness: assessBackgroundTaskLiveness({ lastObservedAt: observation.at, now, quietAfterMs }),
  };
};
