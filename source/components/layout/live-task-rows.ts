import type {
  BackgroundTaskControlDetails,
  ForegroundTransferCandidate,
} from '../../services/session/background-task-control.js';
import type { BackgroundTask } from '../../services/subagents/subagent-notification-store.js';

export type LiveTaskPlacement = 'foreground' | 'background';

export type LiveBackgroundTask = BackgroundTask | BackgroundTaskControlDetails;

export type LiveTaskRow = {
  key: string;
  placement: LiveTaskPlacement;
  task: LiveBackgroundTask | ForegroundTransferCandidate;
};

const liveTaskKey = (task: LiveBackgroundTask | ForegroundTransferCandidate): string => {
  if (task.kind === 'shell') {
    if ('id' in task) return `shell:${task.id}`;
    return `shell:${task.jobId}`;
  }
  if ('id' in task) return `subagent:${task.id}`;
  return `subagent:${task.runId}`;
};

export const isLiveTaskRow = (value: unknown): value is LiveTaskRow =>
  typeof value === 'object' &&
  value !== null &&
  'placement' in value &&
  'task' in value &&
  'key' in value &&
  (value.placement === 'foreground' || value.placement === 'background');

export const mergeLiveTaskRows = ({
  foreground = [],
  background = [],
}: {
  foreground?: readonly ForegroundTransferCandidate[];
  background?: readonly LiveBackgroundTask[];
}): LiveTaskRow[] => [
  ...foreground.map((task) => ({ key: liveTaskKey(task), placement: 'foreground' as const, task })),
  ...background.map((task) => ({ key: liveTaskKey(task), placement: 'background' as const, task })),
];

export const normalizeLiveTaskRows = (tasks: readonly LiveTaskRow[] | readonly LiveBackgroundTask[]): LiveTaskRow[] => {
  if (tasks.length === 0) return [];
  if (isLiveTaskRow(tasks[0])) return [...(tasks as readonly LiveTaskRow[])];
  return mergeLiveTaskRows({ background: tasks as readonly LiveBackgroundTask[] });
};
