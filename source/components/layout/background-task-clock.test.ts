import { expect, it } from 'vitest';
import { BACKGROUND_TASKS_PANEL_GRACE_MS, needsBackgroundTaskClock } from './background-task-clock.js';

const GRACE = BACKGROUND_TASKS_PANEL_GRACE_MS;

it('does not tick an idle session that still retains terminal background rows', () => {
  expect(
    needsBackgroundTaskClock({
      now: 1_000_000,
      detailsTasks: [
        { status: 'cancelled', completedAt: 10_000 },
        {
          status: 'completed',
          activity: { lastObservation: { kind: 'settled', at: 20_000 } },
        },
      ],
      snapshotTasks: [{ status: 'failed', completedAt: 30_000 }],
    }),
  ).toBe(false);
});

it('ticks while any background row is still live', () => {
  expect(
    needsBackgroundTaskClock({
      now: 5_000,
      detailsTasks: [{ status: 'running' }, { status: 'completed', completedAt: 0 }],
    }),
  ).toBe(true);
  expect(
    needsBackgroundTaskClock({
      now: 5_000,
      snapshotTasks: [{ status: 'cancelling' }],
    }),
  ).toBe(true);
  expect(
    needsBackgroundTaskClock({
      now: 5_000,
      detailsTasks: [{ status: 'awaiting_approval' }],
    }),
  ).toBe(true);
});

it('ticks while a foreground transfer candidate is live', () => {
  expect(needsBackgroundTaskClock({ now: 5_000, foregroundCount: 1 })).toBe(true);
});

it('ticks through the panel linger window, then stops at the grace boundary', () => {
  const task = { status: 'completed' as const, completedAt: 10_000 };
  expect(needsBackgroundTaskClock({ now: 10_000 + GRACE - 1, detailsTasks: [task] })).toBe(true);
  expect(needsBackgroundTaskClock({ now: 10_000 + GRACE, detailsTasks: [task] })).toBe(false);
});

it('does not tick retained terminals that never recorded a settle time', () => {
  expect(
    needsBackgroundTaskClock({
      now: 5_000,
      detailsTasks: [{ status: 'completed' }],
    }),
  ).toBe(false);
});
